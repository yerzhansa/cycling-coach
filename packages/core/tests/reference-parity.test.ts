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
 * Reference parity gate's Vitest surface — two responsibilities:
 *
 *   1. Empty-registry contract: when no metrics are registered yet,
 *      the matrix below produces zero parity test cases and the unit
 *      tests above still pin the gate's enforcement semantics.
 *   2. Once metrics register, the cross-product loop populates with
 *      real parity assertions without further test-file edits.
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
    it("returns an array of strings (possibly empty)", () => {
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

  // Vitest 4.x errors on a describe with zero tests; this skipped marker
  // is the one case body so the empty-registry path still has a parseable
  // suite. Real cases fan out below once the registry populates.
  if (metrics.length === 0) {
    it.skip("registry is empty — parity matrix produces 0 test cases", () => {});
    return;
  }

  for (const metric of metrics) {
    for (const fixture of fixtures) {
      it(`${metric} matches snapshot for ${fixture}`, async () => {
        const result = await runParityCheck({ metric, fixture });
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
