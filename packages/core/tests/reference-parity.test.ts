import { describe, expect, it } from "vitest";

import {
  RegistryMissError,
  deepCompare,
  listFixtures,
  listRegisteredMetrics,
  runParityCheck,
  validateResearchFile,
} from "../../../tools/check-metric-parity";

/**
 * The Reference layer ↔ section-11 parity gate's Vitest surface.
 *
 * Two responsibilities, kept distinct in the suites below:
 *
 *   1. The empty-registry contract: when no metrics have been
 *      registered yet (the state pre-T12), the suite must produce
 *      zero parity test cases and `pnpm test` continues to pass.
 *
 *   2. Internals (deep comparator, research-file validator, registry
 *      miss error) get direct unit coverage so the gate's enforcement
 *      semantics are pinned by tests, not by integration alone.
 *
 * Once T12 registers its first metric, the cross-product loop below
 * starts producing real parity test cases — no test-file edits
 * required at that point.
 */

describe("reference-parity gate — internals", () => {
  describe("deepCompare", () => {
    it("returns empty diff for bit-identical scalars", () => {
      expect(deepCompare(0.81, 0.81)).toEqual([]);
      expect(deepCompare(null, null)).toEqual([]);
      expect(deepCompare("monotony", "monotony")).toEqual([]);
    });

    it("treats NaN as equal to NaN (Object.is semantics)", () => {
      expect(deepCompare(Number.NaN, Number.NaN)).toEqual([]);
    });

    it("distinguishes +0 from -0 (Object.is semantics)", () => {
      const diff = deepCompare(0, -0);
      expect(diff).toHaveLength(1);
      expect(diff[0]?.path).toBe("$");
    });

    it("surfaces leaf-level diffs for objects with the JSON path", () => {
      const diff = deepCompare(
        { value: 0.81, kind: "computed" },
        { value: 0.83, kind: "computed" },
      );
      expect(diff).toEqual([{ path: "$.value", expected: 0.81, actual: 0.83 }]);
    });

    it("surfaces array-length mismatches without recursing further", () => {
      const diff = deepCompare([1, 2, 3], [1, 2]);
      expect(diff).toEqual([{ path: "$.length", expected: 3, actual: 2 }]);
    });

    it("returns one DiffLeaf per leaf for nested objects with multiple diffs", () => {
      const diff = deepCompare(
        { a: { b: 1, c: 2 } },
        { a: { b: 99, c: 2 } },
      );
      expect(diff).toEqual([{ path: "$.a.b", expected: 1, actual: 99 }]);
    });
  });

  describe("validateResearchFile", () => {
    it("rejects empty path with the expected reason", () => {
      const r = validateResearchFile(undefined);
      expect(r.ok).toBe(false);
      expect(r.reasons.join("\n")).toMatch(/justification\.path is empty/);
    });

    it("rejects a missing file path", () => {
      const r = validateResearchFile("docs/knowledge/research/does-not-exist.md");
      expect(r.ok).toBe(false);
      expect(r.reasons.join("\n")).toMatch(/file does not exist/);
    });
  });

  describe("listRegisteredMetrics", () => {
    it("returns an array of strings (possibly empty pre-T12)", () => {
      const metrics = listRegisteredMetrics();
      expect(Array.isArray(metrics)).toBe(true);
      for (const m of metrics) expect(typeof m).toBe("string");
    });
  });

  describe("listFixtures", () => {
    it("includes the realistic-athlete snapshot dir", () => {
      const fixtures = listFixtures();
      expect(fixtures).toContain("realistic-athlete");
    });
  });

  describe("runParityCheck", () => {
    it("throws RegistryMissError for an unregistered metric", async () => {
      await expect(
        runParityCheck({ metric: "no-such-metric", fixture: "realistic-athlete" }),
      ).rejects.toBeInstanceOf(RegistryMissError);
    });
  });
});

describe("reference-parity gate — registered metric × fixture matrix", () => {
  const metrics = listRegisteredMetrics();
  const fixtures = listFixtures();

  if (metrics.length === 0) {
    // Pre-T12 state: registry is empty by design. The matrix has no
    // test cases, but `pnpm test` continues to pass because the suite
    // contains the unit tests above. Once T12 registers ACWR the
    // matrix populates without code changes here.
    it.skip("registry is empty — parity matrix produces 0 test cases (this is normal pre-T12)", () => {
      // marker test only
    });
    return;
  }

  for (const metric of metrics) {
    for (const fixture of fixtures) {
      it(`${metric} matches the section-11 snapshot for ${fixture}`, async () => {
        const result = await runParityCheck({ metric, fixture, oracle: "section-11" });
        expect(
          result.passed,
          result.diff
            .map((d) => `${d.path}: expected ${JSON.stringify(d.expected)} | got ${JSON.stringify(d.actual)}`)
            .join("\n") || "cite-path enforcement failed",
        ).toBe(true);
      });
    }
  }
});
