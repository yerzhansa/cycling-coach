/**
 * Intra-kernel discipline lint — `pnpm check:kernel-discipline`.
 *
 * Inside the pure compute kernel (per ADR-0032), the `streams/` and `models/`
 * zones are walled apart from the `reference/` zone: neither may import the
 * other. `numerics/` is the ONE blessed shared seam — importable from all three.
 * All other intra-kernel edges get no opinion. The wall holds identically across
 * the kernel source tree and the kernel test tree.
 *
 * Mechanism, per importing FILE: resolve every RELATIVE module specifier
 * (`import … from`, `export … from`, dynamic `import()`, `require()`) against the
 * importing file's directory (plain `path.resolve`; the kernel has no tsconfig
 * aliases) and classify the resolved path's zone. A `streams`/`models` file that
 * reaches `reference`, or a `reference` file that reaches `streams`/`models`, is
 * a violation. Files opt out with `kernel-discipline-lint:skip-file` in the
 * first 1 KB. Both scan roots are absent-tolerant — today only the placeholder
 * module exists, so the gate prints the not-present notes and exits 0.
 */

import * as ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { TS_EXTS, ext, collectFiles, makeSkipCheck, nonFlagArgs, runGateCli } from "./lint-fs.js";

const KERNEL_DIR = "packages/kernel";
const SCAN_SUBDIRS: readonly string[] = ["src", "tests"];
const WALLED_ZONES: readonly string[] = ["streams", "models"];

const SKIP_DIRECTIVE = "kernel-discipline-lint:skip-file";
const isSkippedFile = makeSkipCheck(SKIP_DIRECTIVE);

type Zone = "streams" | "models" | "reference" | "numerics";
const ZONES: readonly Zone[] = ["streams", "models", "reference", "numerics"];

export interface KernelDisciplineHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly fromZone: Zone;
  readonly toZone: Zone;
  readonly specifier: string;
}

/** First zone directory name appearing as a path segment, or null. */
export function zoneOf(path: string): Zone | null {
  const parts = path.split(sep);
  for (const part of parts) {
    if ((ZONES as readonly string[]).includes(part)) return part as Zone;
  }
  return null;
}

function forbidden(fromZone: Zone, toZone: Zone): boolean {
  if ((fromZone === "streams" || fromZone === "models") && toZone === "reference") return true;
  if (fromZone === "reference" && (toZone === "streams" || toZone === "models")) return true;
  return false;
}

interface SpecifierRef {
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
}

function collectRelativeSpecifiers(file: string): SpecifierRef[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const refs: SpecifierRef[] = [];

  function record(node: ts.Node, specifier: string): void {
    if (!specifier.startsWith(".")) return;
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    refs.push({ line: lc.line + 1, column: lc.character + 1, specifier });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) record(arg, arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return refs;
}

export function findKernelDisciplineHits(files: readonly string[]): KernelDisciplineHit[] {
  const hits: KernelDisciplineHit[] = [];
  for (const file of files) {
    if (!TS_EXTS.has(ext(file))) continue;
    const fromZone = zoneOf(file);
    if (fromZone === null) continue;
    for (const ref of collectRelativeSpecifiers(file)) {
      const resolved = resolve(dirname(file), ref.specifier);
      const toZone = zoneOf(resolved);
      if (toZone === null) continue;
      if (forbidden(fromZone, toZone)) {
        hits.push({
          file,
          line: ref.line,
          column: ref.column,
          fromZone,
          toZone,
          specifier: ref.specifier,
        });
      }
    }
  }
  return hits;
}

export function main(argv: readonly string[]): number {
  const args = nonFlagArgs(argv);
  const root = args[0] ?? ".";

  const files: string[] = [];
  for (const sub of SCAN_SUBDIRS) {
    const base = join(root, KERNEL_DIR, sub);
    if (existsSync(base)) collectFiles(base, files);
  }

  for (const zone of WALLED_ZONES) {
    if (!existsSync(join(root, KERNEL_DIR, "src", zone))) {
      console.log(`check-kernel-discipline: ${KERNEL_DIR}/src/${zone} (not present yet)`);
    }
  }

  const hits = findKernelDisciplineHits(files);
  if (hits.length === 0) {
    console.log(`check-kernel-discipline: ${files.length} kernel file(s) clean.`);
    return 0;
  }
  console.error(`check-kernel-discipline: ${hits.length} forbidden intra-kernel edge(s) found:`);
  for (const h of hits) {
    console.error(
      `  ${h.file}:${h.line}:${h.column}  R9: ${h.fromZone} may not import ${h.toZone} ("${h.specifier}")`,
    );
  }
  console.error(
    `\nThe kernel's streams/ and models/ zones are walled apart from reference/; ` +
      `numerics/ is the only shared seam.`,
  );
  return 1;
}

runGateCli(import.meta.url, main);
