/**
 * Shared file-system / CLI plumbing for the repo's shape-based static gates.
 *
 * Each gate (`tools/check-*.ts`) keeps its own domain logic — the token regex,
 * the id-shape regex + date walk, the identifier AST walk — and imports the
 * generic, domain-free pieces from here: the recursive file walk with its
 * directory-exclusion contract, the TypeScript source-extension set, the
 * extension helper, the skip-directive factory, and the ESM-entry CLI runner.
 *
 * This module is deliberately free of any gate's domain vocabulary so it can be
 * imported by every gate without itself becoming a surface any gate must scan.
 */

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/** The TypeScript source extensions every gate AST-walks. */
export const TS_EXTS: ReadonlySet<string> = new Set([".ts", ".tsx", ".cts", ".mts"]);

/** File extension including the leading dot, or "" if none. */
export function ext(file: string): string {
  return extname(file);
}

/**
 * Recursively collect files under `path` into `out`. Top-level args are
 * statSync'd directly; while RECURSING, node_modules/dist/dotfile entries are
 * skipped (so a dotfile dir passed as an explicit arg — e.g. `.changeset` — is
 * still walked, but a `.cache` dir found inside a tree is not). Missing paths
 * are silently ignored; the caller decides whether empty scope is an error.
 */
export function collectFiles(path: string, out: string[]): void {
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

/**
 * Build a per-gate "is this file opted out?" predicate. A file opts out by
 * placing the gate's skip directive within its first 1 KB, in any comment style.
 */
export function makeSkipCheck(directive: string): (source: string) => boolean {
  return (source: string) => source.slice(0, 1024).includes(directive);
}

/** True when this module's gate file was invoked directly as the ESM entrypoint. */
export function isCliEntry(metaUrl: string): boolean {
  return (
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    metaUrl === `file://${process.argv[1]}`
  );
}

/** Strip flag-style args (`--strict`, `-x`) from an argv list. */
export function nonFlagArgs(argv: readonly string[]): string[] {
  return argv.filter((a) => !a.startsWith("-"));
}

/** Run a gate's `main` and exit with its code when invoked as the CLI entry. */
export function runGateCli(metaUrl: string, main: (argv: readonly string[]) => number): void {
  if (isCliEntry(metaUrl)) process.exit(main(process.argv.slice(2)));
}
