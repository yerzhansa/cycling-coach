// Operator CLI for piping a real intervals.icu JSON dump through the
// privacy-denylist transform. Output lands under
// `tests/fixtures/golden/<name>.json` for committing.
//
// Usage:
//   pnpm exec tsx tools/sanitize-fixture.ts <input.json> <output-name> [--force]

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "../packages/core/src/io/atomic-write-json.js";
import {
  assertNoTpKeysRemain,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
  type RenameSummary,
} from "../packages/core/src/reference/sync/rename-tp-fields.js";
import {
  sanitizeFixtureWithSummary,
  type SanitizeSummary,
} from "../packages/core/tests/helpers/sanitize-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = resolve(
  REPO_ROOT,
  "packages",
  "core",
  "tests",
  "fixtures",
  "golden",
);

export interface MainOptions {
  /** Override the output-root directory. Tests pass tmpdir; production uses
   *  `packages/core/tests/fixtures/golden/`. */
  outputRoot?: string;
  /** Capture stdout. Tests pass a collector; production uses console.log. */
  out?: (msg: string) => void;
  /** Capture stderr. */
  err?: (msg: string) => void;
}

export async function main(argv: string[], opts?: MainOptions): Promise<number> {
  const out = opts?.out ?? ((m: string) => console.log(m));
  const err = opts?.err ?? ((m: string) => console.error(m));
  const outputRoot = opts?.outputRoot ?? DEFAULT_OUTPUT_ROOT;

  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));

  if (positional.length < 2) {
    err(
      "usage: tsx tools/sanitize-fixture.ts <input.json> <output-name> [--force]",
    );
    return 2;
  }

  const [inputPath, outputName] = positional;
  const outputPath = resolve(outputRoot, `${outputName}.json`);
  const force = flags.has("--force");

  if (!force && fileExists(outputPath)) {
    err(`refusing to overwrite ${outputPath} without --force`);
    return 1;
  }

  const raw = readFileSync(inputPath, "utf-8");
  const parsed = JSON.parse(raw);
  const wellnessRenameSummary: RenameSummary = { skippedNonNumeric: {} };
  const activitiesRenameSummary: RenameSummary = { skippedNonNumeric: {} };
  const renamed = {
    ...parsed,
    ...(Array.isArray(parsed.activities) && {
      activities: parsed.activities.map((row: unknown) =>
        renameTpFieldsOnActivity(row as Record<string, unknown>, activitiesRenameSummary),
      ),
    }),
    ...(Array.isArray(parsed.wellness) && {
      wellness: parsed.wellness.map((row: unknown) =>
        renameTpFieldsOnWellnessRow(row as Record<string, unknown>, wellnessRenameSummary),
      ),
    }),
  };

  // Defense-in-depth — see assertNoTpKeysRemain's JSDoc for the invariant.
  try {
    assertNoTpKeysRemain(renamed);
  } catch (e) {
    err((e as Error).message);
    return 3;
  }

  const { data, summary } = sanitizeFixtureWithSummary(renamed);

  await atomicWriteJson(outputPath, data);

  out(`Wrote sanitized fixture: ${outputPath}`);
  for (const line of formatSummary(summary)) out(line);
  for (const line of formatRenameWarnings(wellnessRenameSummary, "wellness")) err(line);
  for (const line of formatRenameWarnings(activitiesRenameSummary, "activities")) err(line);

  return 0;
}

function formatRenameWarnings(
  summary: RenameSummary,
  collection: "wellness" | "activities",
): string[] {
  return Object.entries(summary.skippedNonNumeric)
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([field, count]) =>
        `⚠ Skipped non-number TP values during rename: ${field} (×${count} in ${collection})`,
    );
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function formatSummary(s: SanitizeSummary): string[] {
  const lines: string[] = [];
  const tpEntries = orderedEntries(s.droppedTpKeys);
  if (tpEntries.length > 0) {
    lines.push(`Dropped TP-trademark keys (cosmetic): ${formatCounts(tpEntries)}`);
  }
  const gpsEntries = orderedEntries(s.droppedGpsKeys);
  if (gpsEntries.length > 0) {
    lines.push(`Dropped GPS keys: ${formatCounts(gpsEntries)}`);
  }
  if (s.replacedIds > 0 || s.replacedEmails > 0) {
    const parts: string[] = [];
    if (s.replacedIds > 0) parts.push(`${s.replacedIds} id-shaped fields → mock`);
    if (s.replacedEmails > 0) parts.push(`${s.replacedEmails} emails → redacted@example.com`);
    lines.push(`Replaced ${parts.join("; ")}`);
  }
  const vendorEntries = orderedEntries(s.replacedVendor);
  if (vendorEntries.length > 0) {
    lines.push(`Replaced vendor-correlation strings: ${formatCounts(vendorEntries)}`);
  }
  const freeTextEntries = orderedEntries(s.replacedFreeText);
  if (freeTextEntries.length > 0) {
    lines.push(`Replaced free-text PII fields: ${formatCounts(freeTextEntries)}`);
  }
  return lines;
}

function orderedEntries(record: Record<string, number>): Array<[string, number]> {
  return Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(entries: Array<[string, number]>): string {
  return entries.map(([k, n]) => `${k} (×${n})`).join(", ");
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
