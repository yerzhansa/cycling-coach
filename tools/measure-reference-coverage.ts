/**
 * Branch-coverage report for the Reference layer's derived-metrics oracle.
 *
 * Drives `tools/measure-reference-coverage-native.py` (host CPython 3.12 +
 * coverage.py, via uv) over every committed golden fixture and prints the
 * branches the current fixture set leaves UNEXERCISED in
 * `_calculate_derived_metrics` and the callees it actually enters. Use it
 * before adding a fixture to see which branch a new fixture should target,
 * and after to confirm it landed.
 *
 * Spot-check tool — NOT part of `pnpm test`. It needs `uv` + host Python
 * 3.12 + coverage, which CI doesn't provision (same constraint class as
 * `tools/diff-pyodide-vs-cpython.ts` and `tools/fuzz-parity.ts`). Coverage
 * runs under host CPython rather than the pyodide harness because
 * coverage.py needs a real process + filesystem for its trace hook and data
 * file, which pyodide's WASM sandbox can't give it.
 *
 * Usage:
 *   pnpm coverage:reference                 # human summary to stdout
 *   pnpm coverage:reference --json          # full JSON report to stdout
 *   pnpm coverage:reference --out report.json
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REPO_ROOT } from "./check-metric-parity";
import { HARNESS_FIXTURES } from "./harness-fixtures.js";

const GOLDEN_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");
const SECTION_11_REPO =
  process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");
const NATIVE_SCRIPT = resolve(REPO_ROOT, "tools/measure-reference-coverage-native.py");

interface CoverageReport {
  upstream_sync_py: string;
  fixtures_run: string[];
  fixture_errors: { fixture: string; type: string; message: string }[];
  summary: {
    total_statements: number;
    executed_statements: number;
    total_branches: number;
    covered_branches: number;
    functions_entered: number;
    functions_with_gaps: number;
  };
  uncovered_in_entered_functions: {
    function: string;
    start_line: number;
    end_line: number;
    missing_lines: number[];
    missing_branch_arcs: { from: number; to: number }[];
  }[];
}

// Drive coverage over the same fixtures + anchors the snapshot harness uses,
// straight from the shared allowlist — no second copy of the anchor table.
function buildManifest(tmpDir: string): string {
  const entries = HARNESS_FIXTURES.map(({ slug, frozenNow }) => ({
    path: join(GOLDEN_DIR, `${slug}.json`),
    frozen_now: frozenNow,
  }));
  const manifestPath = join(tmpDir, "coverage-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(entries, null, 2));
  return manifestPath;
}

function runNative(manifestPath: string, reportPath: string): void {
  const result = spawnSync(
    "uv",
    [
      "run",
      "--python",
      "3.12",
      "--with",
      "coverage",
      NATIVE_SCRIPT,
      "--manifest",
      manifestPath,
      "--section-11-repo",
      SECTION_11_REPO,
      "--out",
      reportPath,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "[coverage] `uv` not found on PATH. Install it (https://docs.astral.sh/uv/) — this tool needs uv + host Python 3.12 + coverage.",
      );
      process.exit(2);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(`[coverage] native probe exited ${result.status ?? "?"}`);
    process.exit(result.status ?? 1);
  }
}

function printSummary(report: CoverageReport): void {
  const s = report.summary;
  const stmtPct = ((s.executed_statements / s.total_statements) * 100).toFixed(1);
  const brPct = s.total_branches
    ? ((s.covered_branches / s.total_branches) * 100).toFixed(1)
    : "n/a";

  console.log(`[coverage] upstream: ${report.upstream_sync_py}`);
  console.log(`[coverage] fixtures run: ${report.fixtures_run.length} — ${report.fixtures_run.join(", ")}`);
  if (report.fixture_errors.length > 0) {
    console.log(`[coverage] WARN ${report.fixture_errors.length} fixture(s) errored:`);
    for (const e of report.fixture_errors) {
      console.log(`  - ${e.fixture}: ${e.type}: ${e.message}`);
    }
  }
  console.log(
    `[coverage] whole-file statements ${s.executed_statements}/${s.total_statements} (${stmtPct}%), ` +
      `branches ${s.covered_branches}/${s.total_branches} (${brPct}%) — ` +
      `whole-file figures include the API/sync/CLI code the oracle never runs; the per-function gaps below are the signal.`,
  );
  console.log(
    `[coverage] ${s.functions_entered} functions entered by the metrics path; ${s.functions_with_gaps} have unexercised branches:\n`,
  );

  const ranked = [...report.uncovered_in_entered_functions].sort(
    (a, b) =>
      b.missing_branch_arcs.length - a.missing_branch_arcs.length ||
      b.missing_lines.length - a.missing_lines.length,
  );
  for (const fn of ranked) {
    console.log(
      `  ${fn.function.padEnd(42)} L${String(fn.start_line).padStart(4)}-${fn.end_line}` +
        `  ${String(fn.missing_lines.length).padStart(3)} missing lines, ` +
        `${String(fn.missing_branch_arcs.length).padStart(3)} unexercised branch arcs`,
    );
  }
  console.log(
    `\n[coverage] Reading it: large gaps in _calculate_sustainability_profile / _calculate_dfa_a1_profile / ` +
      `_calculate_power_curve_delta / _calculate_hr_curve_delta / _calculate_durability / _calculate_efficiency_factor / ` +
      `_calculate_hrrc_trend / _calculate_tid_comparison are the F10 stream-based metrics — they need stream fixtures (T13). ` +
      `Smaller gaps in non-stream functions are candidate targets for the next golden fixture.`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

  const tmpDir = mkdtempSync(join(tmpdir(), "ref-coverage-"));
  const manifestPath = buildManifest(tmpDir);
  const reportPath = join(tmpDir, "coverage-report.json");

  runNative(manifestPath, reportPath);

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CoverageReport;
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[coverage] report written to ${outPath}`);
  }
  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
  }
}

main();
