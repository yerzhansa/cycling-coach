/**
 * Compare the committed per-metric snapshots (pyodide-generated) against
 * a native CPython run of the same logic via
 * `tools/snapshot-section-11-native.py`. Exit 0 if every populated
 * metric is bit-identical; exit 1 with a structured diff otherwise.
 *
 * The pure comparators (`loadPyodideSnapshots`, `compareSnapshots`) are
 * exported so `tools/native-check-gate.ts` can run the same diff per
 * fixture on the local regen path. This CLI keeps its hand-run behavior:
 * one native JSON argument, diffed against the realistic-athlete pyodide
 * snapshot dir.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { deepCompare, REPO_ROOT } from "./check-metric-parity";

const REALISTIC_ATHLETE_DIR = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/snapshots/realistic-athlete",
);

export interface SnapshotDiff {
  metric: string;
  reason: string;
}

/**
 * Load the committed per-metric pyodide snapshots from a slug's snapshot
 * directory into a metric → value map. Each `*.json` file under `dir` is a
 * wrapper carrying `{ metric, value }`; the value is what the comparator pins.
 */
export function loadPyodideSnapshots(dir: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as {
      metric: string;
      value: unknown;
    };
    out.set(parsed.metric, parsed.value);
  }
  return out;
}

function loadNativeSnapshot(path: string): Map<string, unknown> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return new Map(Object.entries(raw));
}

/**
 * Pure comparator: diff a pyodide metric→value map against a native
 * metric→value map. Returns one `SnapshotDiff` per metric that is missing
 * from either side or whose leaves diverge. An empty array means every
 * shared, populated metric is bit-identical.
 */
export function compareSnapshots(
  pyodide: Map<string, unknown>,
  native: Map<string, unknown>,
): SnapshotDiff[] {
  const allMetrics = new Set([...pyodide.keys(), ...native.keys()]);
  const diffs: SnapshotDiff[] = [];
  for (const metric of allMetrics) {
    if (!pyodide.has(metric)) {
      diffs.push({ metric, reason: "missing from pyodide snapshots" });
      continue;
    }
    if (!native.has(metric)) {
      diffs.push({ metric, reason: "missing from native output" });
      continue;
    }
    const leafDiffs = deepCompare(pyodide.get(metric), native.get(metric));
    if (leafDiffs.length === 0) continue;
    const summary = leafDiffs
      .slice(0, 5)
      .map(
        (d) =>
          `${d.path}: pyodide=${JSON.stringify(d.expected)} cpython=${JSON.stringify(d.actual)}`,
      )
      .join("; ");
    const tail =
      leafDiffs.length > 5 ? ` (+${leafDiffs.length - 5} more leaves)` : "";
    diffs.push({ metric, reason: `${summary}${tail}` });
  }
  return diffs;
}

function main(): number {
  const nativePath = process.argv[2];
  if (!nativePath) {
    const exampleOut = join(tmpdir(), "native-snapshots.json");
    console.error(
      `[diff] usage: tsx tools/diff-pyodide-vs-cpython.ts <native-json-path>\n` +
        `       generate it first: uv run --python 3.12 tools/snapshot-section-11-native.py --out ${exampleOut}`,
    );
    return 2;
  }
  if (!existsSync(nativePath)) {
    console.error(`[diff] native JSON not found: ${nativePath}`);
    return 2;
  }

  const pyodide = loadPyodideSnapshots(REALISTIC_ATHLETE_DIR);
  const native = loadNativeSnapshot(nativePath);
  const diffs = compareSnapshots(pyodide, native);
  const allMetrics = new Set([...pyodide.keys(), ...native.keys()]);
  const matched = allMetrics.size - diffs.length;

  if (diffs.length === 0) {
    console.log(
      `[diff] OK — ${matched} metrics bit-identical across pyodide + CPython.`,
    );
    return 0;
  }

  console.error(`[diff] FAIL — ${diffs.length} divergence(s), ${matched} matched:`);
  for (const d of diffs) {
    console.error(`  ${d.metric}: ${d.reason}`);
  }
  return 1;
}

if (process.argv[1]?.endsWith("diff-pyodide-vs-cpython.ts")) {
  process.exit(main());
}
