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
 * Mechanism: walk the TypeScript AST of every file under each `packages/sport-*`
 * package and flag any *identifier* named `METRIC_REGISTRY`. Identifier-scoping
 * (not a text grep) is deliberate — a comment or string that merely discusses
 * the registry is fine; only an actual code reference (named import, aliased
 * import, member access, mutation) is a violation. Every realistic import/use
 * form surfaces the identifier by name, so this covers them all.
 *
 * One adversarial form is an accepted residual gap, NOT caught here: a dynamic
 * string-keyed access (`ns["METRIC_REGISTRY"]`) reached via a deep import of
 * core internals. The public `@enduragent/core` barrel does not export the
 * registry (pinned in `reference-adapter-delegation-surface`), but deep
 * subpath/relative imports into core are not yet mechanically blocked, so that
 * exotic path is left to reviewer discipline rather than this lint.
 *
 * Files that legitimately name the identifier (this linter, its test) opt out
 * via a `registry-isolation-lint:skip-file` marker in the first 1 KB.
 */

import * as ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RegistryReferenceHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** The registry export sport packages must never reference. */
const TARGET_IDENTIFIER = "METRIC_REGISTRY";

const TS_EXTS = new Set([".ts", ".tsx", ".cts", ".mts"]);

function getExt(file: string): string {
  const i = file.lastIndexOf(".");
  return i === -1 ? "" : file.slice(i);
}

const SKIP_DIRECTIVE = "registry-isolation-lint:skip-file";

function isSkippedFile(source: string): boolean {
  return source.slice(0, 1024).includes(SKIP_DIRECTIVE);
}

function findHitsInTsFile(file: string): RegistryReferenceHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const hits: RegistryReferenceHit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === TARGET_IDENTIFIER) {
      const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ file, line: lc.line + 1, column: lc.character + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return hits;
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
    if (TS_EXTS.has(getExt(file))) out.push(...findHitsInTsFile(file));
  }
  return out;
}

/** Recursively collect scannable files under a directory. */
function collectFiles(path: string, out: string[]): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    out.push(path);
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    collectFiles(join(path, entry), out);
  }
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
  const args = argv.filter((a) => !a.startsWith("-"));
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
    `\nSport packages must delegate to a registry compute's public function ` +
      `(computeDfaA1Profile / computePowerCurveDelta, re-exported from @enduragent/core) ` +
      `and project its output to the thin adapter shape, never reaching into ` +
      `${TARGET_IDENTIFIER} — see ADR-0010.`,
  );
  return 1;
}

// CLI entrypoint when invoked directly via `tsx tools/check-registry-isolation.ts`.
const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  process.exit(main(process.argv.slice(2)));
}
