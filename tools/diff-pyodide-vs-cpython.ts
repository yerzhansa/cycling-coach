/**
 * T09: compare the pyodide harness's per-metric snapshots against
 * a native CPython 3.12 run of the same logic via
 * `tools/snapshot-section-11-native.py`.
 *
 * Usage:
 *
 *   uv run --python 3.12 tools/snapshot-section-11-native.py --out /tmp/native.json
 *   tsx tools/diff-pyodide-vs-cpython.ts /tmp/native.json
 *
 * Exit 0 if every populated metric matches bit-identically (numeric
 * values use Object.is to catch NaN / signed-zero / float drift).
 * Exit 1 otherwise; prints a structured diff to stderr.
 *
 * Spot-check only — runs by hand at T09 setup and on every pyodide
 * version bump. Not part of `pnpm test` because it requires uv +
 * Python 3.12 on the host, which CI doesn't currently install.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
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

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function summarize(value: unknown): string {
  const s = JSON.stringify(value);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function main(): number {
  const nativePath = process.argv[2] ?? "/tmp/native-snapshots.json";
  if (!existsSync(nativePath)) {
    console.error(
      `[diff] native JSON not found: ${nativePath}\n` +
        `       Run: uv run --python 3.12 tools/snapshot-section-11-native.py --out ${nativePath}`,
    );
    return 2;
  }

  const pyodide = loadPyodideSnapshots();
  const native = loadNativeSnapshot(nativePath);

  const allMetrics = new Set([...pyodide.keys(), ...native.keys()]);
  const diffs: { metric: string; reason: string }[] = [];
  let matched = 0;
  for (const metric of allMetrics) {
    const p = pyodide.get(metric);
    const n = native.get(metric);
    if (!pyodide.has(metric)) {
      diffs.push({ metric, reason: `missing from pyodide; native=${summarize(n)}` });
      continue;
    }
    if (!native.has(metric)) {
      diffs.push({ metric, reason: `missing from native; pyodide=${summarize(p)}` });
      continue;
    }
    if (deepEqual(p, n)) {
      matched += 1;
      continue;
    }
    diffs.push({
      metric,
      reason: `pyodide=${summarize(p)} | cpython=${summarize(n)}`,
    });
  }

  if (diffs.length === 0) {
    console.log(`[diff] OK — ${matched} metrics bit-identical across pyodide + CPython 3.12.`);
    return 0;
  }

  console.error(`[diff] FAIL — ${diffs.length} divergence(s), ${matched} matched:`);
  for (const d of diffs) {
    console.error(`  ${d.metric}: ${d.reason}`);
  }
  return 1;
}

process.exit(main());
