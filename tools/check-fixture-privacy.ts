// fixture-privacy-lint:skip-file — this linter's own source legitimately names
// the forbidden shapes (the SYNTHETIC_INTERVALS_ID_ALLOWLIST entries, the
// regexes, the year-threshold constant). Every literal here is a regex shape, a
// year-threshold integer, or a documented synthetic placeholder — never a real
// id or a real-era date. The shape-based design is precisely what makes this
// lint safe to ship in-repo. Same exemption for the linter's test fixtures.
/**
 * Fixture-privacy lint — `pnpm check:fixture-privacy`.
 *
 * Committed golden fixtures derive from a real intervals.icu athlete account.
 * Two classes of identifier must never reach a committed fixture, both enforced
 * here by SHAPE (no real tokens live in this source):
 *
 *   Rule A — real intervals.icu id shape `i\d{8,9}` anywhere under `packages/`
 *            and `tools/`. The documented real shape (see the JSDoc on
 *            ActivitySchema.id) is a lowercase `i` followed by 8-9 digits.
 *            Short synthetic placeholders (`i1`, `i9876543` — <= 7 digits) are
 *            below the shape and pass; the few synthetic placeholders that DO
 *            carry 8-9 digits (so a test can exercise the real string-id shape)
 *            are listed in SYNTHETIC_INTERVALS_ID_ALLOWLIST.
 *
 *   Rule B — current-era ISO dates (year >= CURRENT_ERA_CUTOFF_YEAR) inside
 *            committed golden fixtures that carry real-athlete data. The real
 *            athlete's training calendar is shifted back one full Gregorian
 *            cycle (to the 1990s) so it can never publish race days / rest
 *            patterns. Fully-synthetic golden fixtures (hand-crafted /
 *            fuzz-derived, zero real data) carry fabricated dates and are
 *            exempt via SYNTHETIC_FIXTURE_ALLOWLIST. `.test.ts` source — which
 *            legitimately uses inline current-era dates as test inputs — is NOT
 *            a privacy surface and is out of scope for Rule B.
 *
 * Modeled on tools/check-trademarks.ts: AST walk (string + template literals +
 * comment trivia) for `.ts`, plain regex for `.json`, fenced-code-stripped
 * regex for `.md`, and a `fixture-privacy-lint:skip-file` marker recognized in
 * the first 1 KB.
 */

import * as ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type PrivacyRule = "intervals-id" | "current-era-date";

export interface PrivacyHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: PrivacyRule;
  readonly detail: string;
}

// Real intervals.icu string-id shape: lowercase `i` + 8 or 9 digits.
const INTERVALS_ID_RE = /\bi\d{8,9}\b/g;

// Synthetic placeholders that intentionally carry the 8-9-digit shape so a test
// can exercise the real string-id branch. These are fabricated values, never a
// real account id. Keep in sync with the id-literal sites in the test suite.
export const SYNTHETIC_INTERVALS_ID_ALLOWLIST: ReadonlySet<string> = new Set([
  "i12345678",
  "i12345679",
]);

// Year >= this is "current era" and forbidden inside real-data golden fixtures.
// The de-identifying shift lands real dates in the 1990s; intervals.icu launched
// ~2015 and real fixtures are 2024+, so 2015 sits comfortably between. This is a
// year-threshold CONSTANT (shape config), not a real date.
const CURRENT_ERA_CUTOFF_YEAR = 2015;

// ISO date head at the START of a JSON string value: `YYYY-MM-DD...`.
const ISO_DATE_VALUE_RE = /^(\d{4})-\d{2}-\d{2}/;

// Fully-synthetic golden fixtures (hand-crafted / fuzz-derived / builder-
// generated, zero real-athlete data — see packages/core/tests/fixtures/README.md
// provenance column). Their dates are fabricated, so Rule B does not apply.
// Only the real-data fixtures (realistic-athlete, capability-qualifying,
// curve-equipped) must carry shifted dates. Filenames, not paths.
export const SYNTHETIC_FIXTURE_ALLOWLIST: ReadonlySet<string> = new Set([
  "new-athlete-empty.json",
  "data-gap-mid-history.json",
  "boundary-monotony.json",
  "boundary-sum-strain.json",
  "boundary-zone-total-secs.json",
  "multisport-tie.json",
  "multisport-thin-primary.json",
  "populated-benchmark-and-consistency.json",
  "rest-week-with-baseline.json",
  "dfa-equipped.json",
  "post-break-resume.json",
  "zero-activities.json",
]);

const TS_EXTS = new Set([".ts", ".tsx", ".cts", ".mts"]);
const MD_EXTS = new Set([".md", ".mdx"]);
const JSON_EXTS = new Set([".json"]);

const SKIP_DIRECTIVE = "fixture-privacy-lint:skip-file";

const GOLDEN_FIXTURE_DIR = "packages/core/tests/fixtures/golden";

function getExt(file: string): string {
  const i = file.lastIndexOf(".");
  return i === -1 ? "" : file.slice(i);
}

function basenameOf(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i === -1 ? file : file.slice(i + 1);
}

function isSkippedFile(source: string): boolean {
  return source.slice(0, 1024).includes(SKIP_DIRECTIVE);
}

function* matchIntervalsId(
  text: string,
  baseOffset: number,
): Generator<{ offset: number; value: string }> {
  INTERVALS_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERVALS_ID_RE.exec(text)) !== null) {
    if (SYNTHETIC_INTERVALS_ID_ALLOWLIST.has(m[0])) continue;
    yield { offset: baseOffset + m.index, value: m[0] };
  }
}

// === Rule A: real intervals.icu id shape in source (.ts / .json / .md) ===

function findIdHitsInTsFile(file: string): PrivacyHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const hits: PrivacyHit[] = [];

  function recordHit(offset: number, value: string): void {
    const lc = sf.getLineAndCharacterOfPosition(offset);
    hits.push({
      file,
      line: lc.line + 1,
      column: lc.character + 1,
      rule: "intervals-id",
      detail: `real intervals.icu id shape "${value}" — use a synthetic placeholder (<= 7 digits) or add to SYNTHETIC_INTERVALS_ID_ALLOWLIST`,
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const contentStart = node.getStart(sf) + 1;
      for (const hit of matchIntervalsId(node.text, contentStart)) {
        recordHit(hit.offset, hit.value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    source,
  );
  let kind: ts.SyntaxKind;
  while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      for (const hit of matchIntervalsId(scanner.getTokenText(), start)) {
        recordHit(hit.offset, hit.value);
      }
    }
  }
  return hits;
}

function offsetToLineCol(lineStarts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function buildLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  return lineStarts;
}

function findIdHitsInJsonFile(file: string): PrivacyHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const lineStarts = buildLineStarts(source);
  const hits: PrivacyHit[] = [];
  for (const hit of matchIntervalsId(source, 0)) {
    const { line, column } = offsetToLineCol(lineStarts, hit.offset);
    hits.push({
      file,
      line,
      column,
      rule: "intervals-id",
      detail: `real intervals.icu id shape "${hit.value}" in committed JSON`,
    });
  }
  return hits;
}

function findIdHitsInMdFile(file: string): PrivacyHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const stripped = source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
  const lineStarts = buildLineStarts(stripped);
  const hits: PrivacyHit[] = [];
  for (const hit of matchIntervalsId(stripped, 0)) {
    const { line, column } = offsetToLineCol(lineStarts, hit.offset);
    hits.push({
      file,
      line,
      column,
      rule: "intervals-id",
      detail: `real intervals.icu id shape "${hit.value}" in prose`,
    });
  }
  return hits;
}

// === Rule B: current-era ISO dates inside real-data golden fixtures ===

function walkJsonForDates(
  value: unknown,
  path: string,
  onHit: (path: string, year: number) => void,
): void {
  if (typeof value === "string") {
    const m = ISO_DATE_VALUE_RE.exec(value);
    if (m !== null) {
      const year = Number(m[1]);
      if (year >= CURRENT_ERA_CUTOFF_YEAR) onHit(path, year);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkJsonForDates(item, `${path}[${i}]`, onHit));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The key itself can be date-shaped (streams record keyed by date).
      const km = ISO_DATE_VALUE_RE.exec(k);
      if (km !== null && Number(km[1]) >= CURRENT_ERA_CUTOFF_YEAR) {
        onHit(`${path}.<key:${k}>`, Number(km[1]));
      }
      walkJsonForDates(v, `${path}.${k}`, onHit);
    }
  }
}

function findDateHitsInGoldenFixture(file: string): PrivacyHit[] {
  const base = basenameOf(file);
  if (SYNTHETIC_FIXTURE_ALLOWLIST.has(base)) return [];
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return []; // malformed JSON is a different concern, not ours
  }
  const hits: PrivacyHit[] = [];
  walkJsonForDates(parsed, base, (p, year) => {
    hits.push({
      file,
      line: 0,
      column: 0,
      rule: "current-era-date",
      detail:
        `current-era ISO date (year ${year} >= ${CURRENT_ERA_CUTOFF_YEAR}) at ${p} — ` +
        `regenerate through tools/sanitize-fixture.ts / the build-*-fixture.ts scripts ` +
        `so dates shift back one full Gregorian cycle (the synthetic epoch)`,
    });
  });
  return hits;
}

/** Lint the given files for Rule A (id shape). Extension-routed; non-source skipped. */
export function findIdHits(files: readonly string[]): PrivacyHit[] {
  const out: PrivacyHit[] = [];
  for (const file of files) {
    const ext = getExt(file);
    if (TS_EXTS.has(ext)) out.push(...findIdHitsInTsFile(file));
    else if (JSON_EXTS.has(ext)) out.push(...findIdHitsInJsonFile(file));
    else if (MD_EXTS.has(ext)) out.push(...findIdHitsInMdFile(file));
  }
  return out;
}

/** Lint the given golden-fixture files for Rule B (current-era dates). */
export function findDateHits(goldenFiles: readonly string[]): PrivacyHit[] {
  const out: PrivacyHit[] = [];
  for (const file of goldenFiles) {
    if (getExt(file) === ".json") out.push(...findDateHitsInGoldenFixture(file));
  }
  return out;
}

/** Combined entry — used by the test. */
export function findFixturePrivacyHits(files: readonly string[]): PrivacyHit[] {
  const golden = files.filter((f) => f.includes(GOLDEN_FIXTURE_DIR));
  return [...findIdHits(files), ...findDateHits(golden)];
}

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

const DEFAULT_SCAN_PATHS: readonly string[] = ["packages", "tools"];

function formatHit(hit: PrivacyHit): string {
  const loc = hit.line > 0 ? `${hit.file}:${hit.line}:${hit.column}` : hit.file;
  return `${loc}  [${hit.rule}] ${hit.detail}`;
}

export function main(argv: readonly string[]): number {
  const args = argv.filter((a) => !a.startsWith("-"));
  const inputPaths = args.length > 0 ? args : DEFAULT_SCAN_PATHS;

  const files: string[] = [];
  for (const p of inputPaths) collectFiles(p, files);

  const goldenFiles: string[] = [];
  collectFiles(GOLDEN_FIXTURE_DIR, goldenFiles);

  if (files.length === 0 && goldenFiles.length === 0) {
    console.log("check-fixture-privacy: no files in scope.");
    return 0;
  }

  const hits = [...findIdHits(files), ...findDateHits(goldenFiles)];
  if (hits.length === 0) {
    console.log(
      `check-fixture-privacy: ${files.length} source file(s) + ${goldenFiles.length} golden fixture(s) clean.`,
    );
    return 0;
  }
  console.error(`check-fixture-privacy: ${hits.length} privacy violation(s) found:`);
  for (const hit of hits) console.error("  " + formatHit(hit));
  console.error(
    "\nReal intervals.icu ids (i + 8-9 digits) and current-era dates (>= " +
      `${CURRENT_ERA_CUTOFF_YEAR}) in real-data golden fixtures publish the ` +
      "athlete's account + training calendar. See CONTRIBUTING.md 'Fixture privacy'.",
  );
  return 1;
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  process.exit(main(process.argv.slice(2)));
}
