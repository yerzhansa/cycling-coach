import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareSnapshots } from "./diff-pyodide-vs-cpython.js";
import {
  DEFAULT_FROZEN_NOW,
  HARNESS_FIXTURES,
  resolveFixtureAnchor,
} from "./harness-fixtures.js";
import {
  decideNativeGate,
  readSlugFrozenNow,
  type FixtureDiff,
} from "./native-check-gate.js";

/**
 * Tests for the native runtime-parity gate's decision logic and its
 * frozen-now anchor sourcing. The heavy end-to-end path (spawning `uv`,
 * running the CPython twin) stays out of `pnpm test`; the gate's branch
 * logic is exercised here without shelling out, mirroring
 * tools/check-fixture-privacy.test.ts's pure-helper style. The diffs fed in
 * are built via the real `compareSnapshots` so the test pins the same
 * comparator the orchestrator uses.
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

  it("throws when a wrong-anchor native run diverges from 1998-anchored snapshots", () => {
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

describe("readSlugFrozenNow", () => {
  function withSnapshotDir(
    files: Record<string, unknown>,
    fn: (dir: string) => void,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), "native-gate-test-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(
          join(dir, name),
          typeof content === "string" ? content : JSON.stringify(content),
        );
      }
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("sources the anchor from the just-written snapshot wrapper, not any default", () => {
    withSnapshotDir(
      {
        "monotony.json": {
          metric: "monotony",
          frozen_now: "1998-05-10T12:00:00",
          value: 1.24,
        },
      },
      (dir) => {
        expect(readSlugFrozenNow(dir)).toBe("1998-05-10T12:00:00");
      },
    );
  });

  it("ignores non-json entries and json files without a frozen_now field", () => {
    withSnapshotDir(
      {
        "notes.txt": "not a snapshot",
        "no-anchor.json": { metric: "acwr", value: null },
        "strain.json": {
          metric: "strain",
          frozen_now: "2026-05-20T12:00:00",
          value: 326,
        },
      },
      (dir) => {
        expect(readSlugFrozenNow(dir)).toBe("2026-05-20T12:00:00");
      },
    );
  });

  it("throws an instructive error when no snapshot carries an anchor", () => {
    withSnapshotDir(
      { "no-anchor.json": { metric: "acwr", value: null } },
      (dir) => {
        expect(() => readSlugFrozenNow(dir)).toThrow(
          /could not source frozen_now/,
        );
      },
    );
  });
});

describe("stale-default anchor regression locks", () => {
  it("native twin's --frozen-now default matches the realistic-athlete de-identify anchor", () => {
    // The actual regression lock for the false-red the gate exists to prevent:
    // reverting the twin's argparse default to the current-era anchor must
    // fail here, pinned against the allowlist's single source of truth.
    const twinSource = readFileSync(
      new URL("./snapshot-section-11-native.py", import.meta.url),
      "utf8",
    );
    const match = twinSource.match(/"--frozen-now"[^]*?default="([^"]+)"/);
    expect(match).not.toBeNull();
    const realisticAthlete = HARNESS_FIXTURES.find(
      (f) => f.slug === "realistic-athlete",
    );
    expect(match![1]).toBe(realisticAthlete?.frozenNow);
    expect(match![1]).not.toBe(DEFAULT_FROZEN_NOW);
  });

  it("resolveFixtureAnchor maps allowlisted slugs to their own anchor and unknown slugs to the default", () => {
    expect(resolveFixtureAnchor("realistic-athlete")).toBe(
      "1998-05-10T12:00:00",
    );
    expect(resolveFixtureAnchor("capability-qualifying")).toBe(
      "1998-05-10T12:00:00",
    );
    expect(resolveFixtureAnchor("curve-equipped")).toBe("1998-06-04T12:00:00");
    expect(resolveFixtureAnchor("some-temp-debug-fixture")).toBe(
      DEFAULT_FROZEN_NOW,
    );
  });
});
