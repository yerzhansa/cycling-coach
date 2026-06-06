/**
 * Native runtime-parity gate for the snapshot regen path.
 *
 * `pnpm snapshot:section-11` regenerates the pyodide oracle snapshots.
 * Pyodide ships CPython compiled to WebAssembly; ~99% of stdlib behavior
 * matches host CPython, but `math.fsum`, `statistics` edge cases, and
 * float-repr have historically diverged. This gate runs the native-CPython
 * twin (`tools/snapshot-section-11-native.py` under `uv`) against every
 * just-regenerated fixture and asserts bit-identity. A red diff THROWS so
 * the harness exits non-zero and the operator reverts the written-but-
 * unverified snapshots via `git checkout`.
 *
 * The gate lives ONLY on the local regen path — CI never regenerates, so it
 * never provisions `uv` and never runs this. The `--skip-native-check` flag
 * (or `SKIP_NATIVE_CHECK=1`) bypasses it with a loud warning for the rare
 * case where the operator genuinely cannot run host CPython.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareSnapshots,
  loadPyodideSnapshots,
  type SnapshotDiff,
} from "./diff-pyodide-vs-cpython.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const NATIVE_TWIN = resolve(__dirname, "snapshot-section-11-native.py");
const GOLDEN_DIR = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");

export interface FixtureDiff {
  slug: string;
  diffs: SnapshotDiff[];
}

export type GateAction = "pass" | "skip" | "throw";

export interface GateDecision {
  action: GateAction;
  message: string;
}

const UV_MISSING_MESSAGE =
  "[snapshot] native-check gate requires `uv` (host CPython runner) and it was not found on PATH.\n" +
  "Install it and a 3.12 toolchain, then re-run the regen:\n" +
  "  curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12\n" +
  "Override the interpreter with NATIVE_PYTHON=<version> if 3.12 is unavailable.\n" +
  "As a LOUD last resort only, re-run with --skip-native-check (or SKIP_NATIVE_CHECK=1) to\n" +
  "bypass the cross-check — but pyodide-only snapshots are then NOT verified against host CPython.";

const SKIP_WARNING =
  "\n" +
  "================================================================================\n" +
  "  WARNING: native runtime-parity check BYPASSED (--skip-native-check)\n" +
  "  The just-regenerated pyodide snapshots were NOT cross-checked against host\n" +
  "  CPython. Pyodide is CPython-on-WASM; math.fsum / statistics / float-repr\n" +
  "  can diverge in narrow cases, producing snapshots that the gate would catch.\n" +
  "  Re-run `pnpm snapshot:section-11` WITHOUT the flag before committing.\n" +
  "================================================================================\n";

/**
 * Pure decision: given whether the operator asked to skip, whether `uv` is
 * available, and the aggregated per-fixture diffs, decide what the gate does.
 * Kept side-effect-free so it can be unit-tested without shelling out.
 *
 * Precedence: skip wins over everything (the operator explicitly opted out);
 * then a missing `uv` is a hard throw (never a silent pass); then non-empty
 * diffs throw; otherwise pass.
 */
export function decideNativeGate(input: {
  skip: boolean;
  uvAvailable: boolean;
  diffs: FixtureDiff[];
}): GateDecision {
  if (input.skip) {
    return { action: "skip", message: SKIP_WARNING };
  }
  if (!input.uvAvailable) {
    return { action: "throw", message: UV_MISSING_MESSAGE };
  }
  const divergent = input.diffs.filter((f) => f.diffs.length > 0);
  if (divergent.length > 0) {
    const lines: string[] = [
      `[snapshot] native-check FAILED — ${divergent.length} fixture(s) diverge from host CPython:`,
    ];
    for (const fixture of divergent) {
      lines.push(`  fixture '${fixture.slug}':`);
      for (const d of fixture.diffs) {
        lines.push(`    - ${d.metric}: ${d.reason}`);
      }
    }
    lines.push("");
    lines.push(
      "Do NOT commit these snapshots — they were written but failed runtime-parity.",
    );
    lines.push(
      "Revert with: git checkout packages/core/tests/fixtures/snapshots",
    );
    return { action: "throw", message: lines.join("\n") };
  }
  return { action: "pass", message: "" };
}

function isUvAvailable(): boolean {
  const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * Read the frozen-now anchor the harness actually wrote for a slug. CRITICAL:
 * sourced from the just-written snapshot's `frozen_now` field, NOT the native
 * twin's default — the de-identified realistic-athlete snapshots are
 * 1998-anchored, and the twin's 2026 default would produce a false-red diff.
 */
export function readSlugFrozenNow(slugSnapshotDir: string): string {
  for (const entry of readdirSync(slugSnapshotDir)) {
    if (!entry.endsWith(".json")) continue;
    const parsed = JSON.parse(
      readFileSync(join(slugSnapshotDir, entry), "utf8"),
    ) as { frozen_now?: string };
    if (typeof parsed.frozen_now === "string") return parsed.frozen_now;
  }
  throw new Error(
    `[snapshot] native-check could not source frozen_now from any snapshot under ${slugSnapshotDir}`,
  );
}

function runNativeTwin(args: {
  section11Repo: string;
  nativePython: string;
  goldenPath: string;
  frozenNow: string;
  outPath: string;
}): void {
  execFileSync(
    "uv",
    [
      "run",
      "--python",
      args.nativePython,
      "--no-project",
      NATIVE_TWIN,
      "--section-11-repo",
      args.section11Repo,
      "--fixture",
      args.goldenPath,
      "--frozen-now",
      args.frozenNow,
      "--out",
      args.outPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function loadNativeMap(path: string): Map<string, unknown> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return new Map(Object.entries(raw));
}

export interface RunGateInput {
  snapshotRoot: string;
  fixtures: { slug: string; metrics: string[] }[];
  skip: boolean;
  section11Repo?: string;
  nativePython?: string;
}

/**
 * Orchestrate the gate: pre-flight `uv`, run the native twin per fixture with
 * the frozen-now sourced from each just-written snapshot, compare against the
 * pyodide snapshots, aggregate, and act on the pure decision. Throws on a red
 * diff or a missing `uv` (unless skipped); prints a one-line OK on green.
 */
export async function runNativeCheckGate(input: RunGateInput): Promise<void> {
  if (input.skip) {
    const decision = decideNativeGate({ skip: true, uvAvailable: false, diffs: [] });
    process.stderr.write(`${decision.message}\n`);
    return;
  }

  const uvAvailable = isUvAvailable();
  if (!uvAvailable) {
    const decision = decideNativeGate({ skip: false, uvAvailable, diffs: [] });
    throw new Error(decision.message);
  }

  const section11Repo =
    input.section11Repo ??
    process.env.SECTION_11_REPO ??
    resolve(REPO_ROOT, "../section-11");
  const nativePython = input.nativePython ?? process.env.NATIVE_PYTHON ?? "3.12";

  const tmpRoot = mkdtempSync(join(tmpdir(), "native-check-gate-"));
  const fixtureDiffs: FixtureDiff[] = [];
  let totalMetrics = 0;
  try {
    for (const fixture of input.fixtures) {
      const slugSnapshotDir = join(input.snapshotRoot, fixture.slug);
      const goldenPath = join(GOLDEN_DIR, `${fixture.slug}.json`);
      const frozenNow = readSlugFrozenNow(slugSnapshotDir);
      const outPath = join(tmpRoot, `${fixture.slug}.native.json`);

      runNativeTwin({
        section11Repo,
        nativePython,
        goldenPath,
        frozenNow,
        outPath,
      });

      const pyodideMap = loadPyodideSnapshots(slugSnapshotDir);
      const nativeMap = loadNativeMap(outPath);
      totalMetrics += pyodideMap.size;
      fixtureDiffs.push({
        slug: fixture.slug,
        diffs: compareSnapshots(pyodideMap, nativeMap),
      });
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const decision = decideNativeGate({
    skip: false,
    uvAvailable: true,
    diffs: fixtureDiffs,
  });

  if (decision.action === "throw") {
    throw new Error(decision.message);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[snapshot] native-check OK — ${totalMetrics} metrics x ${input.fixtures.length} fixtures bit-identical`,
  );
}
