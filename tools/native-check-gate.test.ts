import { describe, expect, it } from "vitest";

import { compareSnapshots } from "./diff-pyodide-vs-cpython.js";
import { decideNativeGate, type FixtureDiff } from "./native-check-gate.js";

/**
 * Pure-function tests for the native runtime-parity gate's decision logic.
 * The heavy end-to-end path (spawning `uv`, running the CPython twin) stays
 * out of `pnpm test`; the gate's branch logic is exercised here without
 * shelling out, mirroring tools/check-fixture-privacy.test.ts's pure-helper
 * style. The diffs fed in are built via the real `compareSnapshots` so the
 * test pins the same comparator the orchestrator uses.
 */

function fixtureDiff(
  slug: string,
  pyodide: Record<string, unknown>,
  native: Record<string, unknown>,
): FixtureDiff {
  return {
    slug,
    diffs: compareSnapshots(
      new Map(Object.entries(pyodide)),
      new Map(Object.entries(native)),
    ),
  };
}

describe("decideNativeGate", () => {
  it("passes when every fixture's maps are identical", () => {
    const diffs = [
      fixtureDiff(
        "realistic-athlete",
        { monotony: 1.24, acwr: { ratio: 0.9 } },
        { monotony: 1.24, acwr: { ratio: 0.9 } },
      ),
    ];
    const decision = decideNativeGate({ skip: false, uvAvailable: true, diffs });
    expect(decision.action).toBe("pass");
  });

  it("throws naming the metric and leaf path on one divergent leaf", () => {
    const diffs = [
      fixtureDiff(
        "realistic-athlete",
        { strain: { value: 326 } },
        { strain: { value: 325 } },
      ),
    ];
    const decision = decideNativeGate({ skip: false, uvAvailable: true, diffs });
    expect(decision.action).toBe("throw");
    expect(decision.message).toContain("strain");
    expect(decision.message).toContain("$.value");
    expect(decision.message).toContain("realistic-athlete");
    expect(decision.message).toContain("git checkout");
  });

  it("skips with the loud WARNING banner regardless of diffs", () => {
    const diffs = [
      fixtureDiff(
        "realistic-athlete",
        { monotony: 1.24 },
        { monotony: 1.23 },
      ),
    ];
    const decision = decideNativeGate({ skip: true, uvAvailable: false, diffs });
    expect(decision.action).toBe("skip");
    expect(decision.message).toContain("WARNING");
    expect(decision.message).toContain("--skip-native-check");
    expect(decision.message).toContain("NOT cross-checked");
  });

  it("throws with install instructions when uv is missing and skip is false", () => {
    const decision = decideNativeGate({
      skip: false,
      uvAvailable: false,
      diffs: [],
    });
    expect(decision.action).toBe("throw");
    expect(decision.message).toContain("uv");
    expect(decision.message).toContain("astral.sh/uv/install.sh");
    expect(decision.message).toContain("NATIVE_PYTHON");
  });

  it("locks in the stale-default bug: a 1998-anchored pyodide map vs a 2026-run native map diverges and throws", () => {
    // Reproduces the false-red the design calls out: the realistic-athlete
    // snapshots are 1998-anchored after the de-identify shift, so window-bound
    // metrics computed at a 2026 frozen-now diverge from the committed (1998)
    // values. Sourcing the wrong frozen-now must therefore throw, never pass.
    const pyodide1998 = {
      load_7d: { total: 525.0 },
      monotony: 1.24,
      activity_dates: ["1998-05-04", "1998-05-10"],
    };
    const native2026 = {
      load_7d: { total: 0.0 },
      monotony: null,
      activity_dates: [],
    };
    const diffs = [fixtureDiff("realistic-athlete", pyodide1998, native2026)];
    expect(diffs[0]!.diffs.length).toBeGreaterThan(0);
    const decision = decideNativeGate({ skip: false, uvAvailable: true, diffs });
    expect(decision.action).toBe("throw");
    expect(decision.message).toContain("realistic-athlete");
  });
});
