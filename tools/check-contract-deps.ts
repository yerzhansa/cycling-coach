/**
 * Contract dependency gate — `pnpm check:contract-deps`.
 *
 * The contract package (`packages/coach-contract`) is the leaf every surface
 * and the engine both depend on. A single stray import from the workspace or
 * the host would create exactly the cycle / host-binding the seam exists to
 * prevent, so this gate enforces two properties of that package:
 *
 * (a) Manifest: `package.json` must be `private: true` with `dependencies`
 *     whose key set is EXACTLY `["zod"]`, and no populated
 *     `peerDependencies` / `optionalDependencies` / `bundledDependencies`.
 *     `devDependencies` are NOT checked — build/test tooling does not ship
 *     and creates no runtime import edge; the import walk guards the real
 *     edges.
 *
 * (b) Imports: every module specifier in every TS file under the package's
 *     `src` must be relative (`./`, `../`) or `zod` / `zod/...`. Everything
 *     else — `node:*` builtins, bare builtins, workspace packages, any other
 *     bare specifier — is a violation. Type-only imports count: a type edge
 *     is still a workspace dependency edge.
 *
 * A missing or unparseable `package.json` is itself a violation — a silently
 * un-armed gate must go red, not green (this guards against a future package
 * rename quietly disarming the gate).
 *
 * Files opt out via a `contract-deps-lint:skip-file` directive in their first
 * 1 KB.
 */

import * as ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TS_EXTS, ext, collectFiles, makeSkipCheck, nonFlagArgs, runGateCli } from "./lint-fs.js";

export interface ContractDepsViolation {
  readonly file: string;
  readonly line: number; // 0 for manifest-level violations
  readonly column: number; // 0 for manifest-level violations
  readonly message: string;
}

const CONTRACT_PACKAGE_DIR = "packages/coach-contract";

const SKIP_DIRECTIVE = "contract-deps-lint:skip-file";

const isSkippedFile = makeSkipCheck(SKIP_DIRECTIVE);

/** A specifier is allowed iff it is relative or resolves within zod. */
export function isAllowedSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "zod" ||
    specifier.startsWith("zod/")
  );
}

function entryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  return 0;
}

/**
 * Check the manifest property. A missing or unparseable `package.json` is a
 * violation, never a vacuous pass.
 */
export function checkContractManifest(packageJsonPath: string): ContractDepsViolation[] {
  const manifestViolation = (message: string): ContractDepsViolation => ({
    file: packageJsonPath,
    line: 0,
    column: 0,
    message,
  });

  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf-8");
  } catch {
    return [manifestViolation("missing package.json — the gate's scope no longer exists; a renamed or moved contract package must be re-pointed here, not silently skipped")];
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return [manifestViolation("unparseable package.json")];
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [manifestViolation("package.json is not an object")];
  }
  const pkg = manifest as Record<string, unknown>;

  const violations: ContractDepsViolation[] = [];

  if (pkg["private"] !== true) {
    violations.push(manifestViolation('"private" must be true'));
  }

  const deps = pkg["dependencies"];
  const depKeys =
    deps !== null && typeof deps === "object" && !Array.isArray(deps) ? Object.keys(deps) : [];
  if (!depKeys.includes("zod")) {
    violations.push(manifestViolation('"dependencies" must contain exactly { "zod": ... } — zod is missing'));
  }
  for (const key of depKeys) {
    if (key !== "zod") {
      violations.push(manifestViolation(`"dependencies" must contain exactly { "zod": ... } — forbidden dependency "${key}"`));
    }
  }

  for (const field of ["peerDependencies", "optionalDependencies", "bundledDependencies"]) {
    if (entryCount(pkg[field]) > 0) {
      violations.push(manifestViolation(`"${field}" must be absent or empty`));
    }
  }

  return violations;
}

function findImportViolationsInTsFile(file: string): ContractDepsViolation[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const violations: ContractDepsViolation[] = [];

  function flag(node: ts.Node, specifier: string): void {
    if (isAllowedSpecifier(specifier)) return;
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({
      file,
      line: lc.line + 1,
      column: lc.character + 1,
      message: `forbidden module specifier "${specifier}" — only relative imports and zod are allowed`,
    });
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      flag(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      flag(node.moduleReference.expression, node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const arg = node.arguments[0]!;
      if ((isDynamicImport || isRequire) && ts.isStringLiteralLike(arg)) {
        flag(arg, arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return violations;
}

/** Scan the given files for forbidden (non-relative, non-zod) module specifiers. */
export function findForbiddenImports(files: readonly string[]): ContractDepsViolation[] {
  const out: ContractDepsViolation[] = [];
  for (const file of files) {
    if (TS_EXTS.has(ext(file))) out.push(...findImportViolationsInTsFile(file));
  }
  return out;
}

function formatViolation(v: ContractDepsViolation): string {
  if (v.line === 0) return `${v.file}: ${v.message}`;
  return `${v.file}:${v.line}:${v.column}  ${v.message}`;
}

export function main(argv: readonly string[]): number {
  const args = nonFlagArgs(argv);
  const dirs = args.length > 0 ? args : [CONTRACT_PACKAGE_DIR];

  const violations: ContractDepsViolation[] = [];
  let scannedFiles = 0;
  for (const dir of dirs) {
    violations.push(...checkContractManifest(join(dir, "package.json")));
    const files: string[] = [];
    collectFiles(join(dir, "src"), files);
    const tsFiles = files.filter((f) => TS_EXTS.has(ext(f)));
    scannedFiles += tsFiles.length;
    violations.push(...findForbiddenImports(tsFiles));
  }

  if (violations.length === 0) {
    console.log(
      `check-contract-deps: ${dirs.join(", ")} clean — ${scannedFiles} source file(s) scanned.`,
    );
    return 0;
  }
  console.error(`check-contract-deps: ${violations.length} violation(s) found:`);
  for (const v of violations) console.error("  " + formatViolation(v));
  console.error(
    `\nThe contract package may depend on zod only; move host or workspace needs ` +
      `behind the engine seam. The package is the leaf every surface and the engine ` +
      `both depend on — any other dependency edge re-creates the coupling the seam ` +
      `exists to prevent.`,
  );
  return 1;
}

runGateCli(import.meta.url, main);
