// registry-isolation-lint:skip-file — this linter's own source names the
// guarded identifier (TARGET_IDENTIFIER, JSDoc, remediation text). Every
// occurrence here is a string literal or comment, never a code reference to the
// registry, so the AST walk would not flag it; the marker is belt-and-suspenders
// and keeps the tool consistent with the other shape-based gates.
/**
 * Registry-isolation lint — `pnpm check:registry-isolation`.
 *
 * This is the static-lint half of ADR-0010's "no-second-writer" guard. A
 * per-sport adapter hook that surfaces a registry-owned metric MUST delegate to
 * the registry's public compute (e.g. `computeDfaA1Profile` /
 * `computePowerCurveDelta`, re-exported from `@enduragent/core`) and project the
 * result down to the thin adapter shape — it MUST NOT reach into the registry
 * itself and become a second writer.
 *
 * The other half lives in a Core test (`reference-adapter-delegation-surface`)
 * that pins the sorted `Object.keys(METRIC_REGISTRY)` set — a second adapter
 * that re-registered a capability metric would add a registry key and fail that
 * baseline. The key-set pin catches a second *registered* writer; this lint
 * catches a sport package reaching for the registry by name at all — the form
 * the key-set pin cannot see because such code adds no registry key.
 *
 * Mechanism: discover every `packages/sport-*` directory, walk each TypeScript
 * AST, and reject either an identifier named `METRIC_REGISTRY` or a module
 * specifier that reaches the dedicated kernel registry subpath. The specifier
 * check covers both `@enduragent/kernel/reference/registry` and relative paths
 * that resolve to the canonical kernel registry source. Comments and unrelated
 * string literals remain allowed.
 *
 * The dedicated registry subpath is intentionally reachable by core
 * compatibility shims and parity tools. Sport packages instead use public
 * compute functions from the grouped metrics facade. The exact and resolved-
 * relative specifier checks prevent namespace, string-key, and dynamic-import
 * forms from bypassing the identifier walk.
 *
 * Files that legitimately name the identifier (this linter, its test) opt out
 * via a `registry-isolation-lint:skip-file` marker in the first 1 KB.
 */

import * as ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { TS_EXTS, ext, collectFiles, makeSkipCheck, nonFlagArgs, runGateCli } from "./lint-fs.js";

export interface RegistryReferenceHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** The registry export sport packages must never reference. */
const TARGET_IDENTIFIER = "METRIC_REGISTRY";
const TARGET_MODULE_SPECIFIER = "@enduragent/kernel/reference/registry";
const CANONICAL_REGISTRY_SUFFIX =
  "/packages/kernel/src/reference/metrics/registry";
const MODULE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

function specifierForNode(node: ts.Node): ts.StringLiteralLike | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  ) {
    return node.arguments[0]!;
  }
  return null;
}

function isCanonicalRelativeRegistry(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(file), specifier)
    .replace(MODULE_EXT_RE, "")
    .split(sep)
    .join("/");
  return target.endsWith(CANONICAL_REGISTRY_SUFFIX);
}

function isGuardedSpecifier(file: string, specifier: string): boolean {
  return (
    specifier === TARGET_MODULE_SPECIFIER ||
    isCanonicalRelativeRegistry(file, specifier)
  );
}

const SKIP_DIRECTIVE = "registry-isolation-lint:skip-file";

const isSkippedFile = makeSkipCheck(SKIP_DIRECTIVE);

function findHitsInTsFile(file: string): RegistryReferenceHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const hits = new Map<string, RegistryReferenceHit>();
  const addHit = (node: ts.Node): void => {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const hit = { file, line: lc.line + 1, column: lc.character + 1 };
    hits.set(`${hit.file}:${hit.line}:${hit.column}`, hit);
  };
  const isInsideGuardedStatement = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node;
    while (current !== undefined && current !== sf) {
      const specifier = specifierForNode(current);
      if (specifier !== null && isGuardedSpecifier(file, specifier.text)) return true;
      current = current.parent;
    }
    return false;
  };

  function visit(node: ts.Node): void {
    const specifier = specifierForNode(node);
    if (specifier !== null && isGuardedSpecifier(file, specifier.text)) {
      addHit(specifier);
    } else if (
      ts.isIdentifier(node) &&
      node.text === TARGET_IDENTIFIER &&
      !isInsideGuardedStatement(node)
    ) {
      addHit(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return [...hits.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
}

/**
 * Scan the given files for sport-package references to `METRIC_REGISTRY`.
 *
 * Files with unsupported extensions are skipped silently so the script can
 * accept `git diff --name-only` output without per-extension pre-filtering.
 */
export function findRegistryReferences(files: readonly string[]): RegistryReferenceHit[] {
  const out: RegistryReferenceHit[] = [];
  for (const file of files) {
    if (TS_EXTS.has(ext(file))) out.push(...findHitsInTsFile(file));
  }
  return out;
}

const PACKAGES_DIR = "packages";

/**
 * Discover every `packages/sport-*` directory so a new sport package is covered
 * the moment it lands, without editing this tool. This is the dynamic analogue
 * of the sibling gates' static `DEFAULT_SCAN_PATHS` constant.
 */
export function discoverSportPackageDirs(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(PACKAGES_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.startsWith("sport-"))
    .map((e) => join(PACKAGES_DIR, e))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function formatHit(hit: RegistryReferenceHit): string {
  return `${hit.file}:${hit.line}:${hit.column}  forbidden reference to ${TARGET_IDENTIFIER}`;
}

export function main(argv: readonly string[]): number {
  const args = nonFlagArgs(argv);
  const inputPaths = args.length > 0 ? args : discoverSportPackageDirs();
  const files: string[] = [];
  for (const p of inputPaths) collectFiles(p, files);

  if (files.length === 0) {
    console.log("check-registry-isolation: no sport-package files in scope.");
    return 0;
  }
  const hits = findRegistryReferences(files);
  if (hits.length === 0) {
    console.log(`check-registry-isolation: ${files.length} sport-package file(s) clean.`);
    return 0;
  }
  console.error(
    `check-registry-isolation: ${hits.length} forbidden ${TARGET_IDENTIFIER} reference(s) found:`,
  );
  for (const hit of hits) console.error("  " + formatHit(hit));
  console.error(
    `\nSport packages must delegate to a public compute function from ` +
      `@enduragent/kernel/reference/metrics and project its output to the thin ` +
      `adapter shape; they must never import or reference ${TARGET_IDENTIFIER}.`,
  );
  return 1;
}

runGateCli(import.meta.url, main);
