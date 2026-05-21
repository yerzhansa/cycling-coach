/**
 * Compare the committed per-metric snapshots (pyodide-generated) against
 * a native CPython run of the same logic via
 * `tools/snapshot-section-11-native.py`. Exit 0 if every populated
 * metric is bit-identical; exit 1 with a structured diff otherwise.
 *
 * Spot-check tool — not part of `pnpm test` because it needs `uv` +
 * host Python 3.12, which CI doesn't currently provision. Run by
 * hand at setup, on pyodide upgrades, and on upstream SHA bumps.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { deepCompare, REPO_ROOT } from "./check-metric-parity";

const SNAPSHOT_DIR = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/snapshots/realistic-athlete",
);

function loadPyodideSnapshots(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const entry of readdirSync(SNAPSHOT_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const parsed = JSON.parse(
      readFileSync(join(SNAPSHOT_DIR, entry), "utf8"),
    ) as { metric: string; value: unknown };
    out.set(parsed.metric, parsed.value);
  }
  return out;
}

function loadNativeSnapshot(path: string): Map<string, unknown> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return new Map(Object.entries(raw));
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

  const pyodide = loadPyodideSnapshots();
  const native = loadNativeSnapshot(nativePath);

  const allMetrics = new Set([...pyodide.keys(), ...native.keys()]);
  const diffs: { metric: string; reason: string }[] = [];
  let matched = 0;
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
    if (leafDiffs.length === 0) {
      matched += 1;
      continue;
    }
    const summary = leafDiffs
      .slice(0, 5)
      .map((d) => `${d.path}: pyodide=${JSON.stringify(d.expected)} cpython=${JSON.stringify(d.actual)}`)
      .join("; ");
    const tail = leafDiffs.length > 5 ? ` (+${leafDiffs.length - 5} more leaves)` : "";
    diffs.push({ metric, reason: `${summary}${tail}` });
  }

  if (diffs.length === 0) {
    console.log(`[diff] OK — ${matched} metrics bit-identical across pyodide + CPython.`);
    return 0;
  }

  console.error(`[diff] FAIL — ${diffs.length} divergence(s), ${matched} matched:`);
  for (const d of diffs) {
    console.error(`  ${d.metric}: ${d.reason}`);
  }
  return 1;
}

process.exit(main());
