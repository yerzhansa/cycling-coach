import { describe, it, expect } from "vitest";
import type { UsageLedgerLine } from "../../packages/core/src/usage-ledger.js";
import {
  drawsVerdict,
  cacheEvidence,
  factScore,
  median,
  mustPreserveDiff,
  parseJudgeVerdict,
  tierJTranscriptVerdict,
  type JudgeVerdict,
} from "./checks.js";

const INVENTORY = Array.from({ length: 10 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);

function run(preservedCount: number, fabrications: number): JudgeVerdict {
  const preserved = INVENTORY.slice(0, preservedCount);
  const missing = INVENTORY.slice(preservedCount);
  return {
    factsPreserved: preserved,
    factsMissing: missing,
    fabrications: Array.from({ length: fabrications }, (_, i) => `fab-${i}`),
  };
}

function compactLine(cacheWriteTokens: number, cacheReadTokens: number): UsageLedgerLine {
  return {
    ts: 0,
    kind: "generate",
    caller: "compact",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    durationMs: 1,
    cacheWriteTokens,
    cacheReadTokens,
  };
}

describe("mustPreserveDiff", () => {
  it("returns empty when a planted in-scope token is present in the summary", () => {
    expect(
      mustPreserveDiff({
        tokens: ["FTP 262W"],
        sourceText: "user: my FTP 262W today",
        summary: "## Athlete Profile\n- FTP 262W",
      }),
    ).toEqual([]);
  });

  it("lists a planted in-scope token that is absent from the summary (deliberate-failure case)", () => {
    expect(
      mustPreserveDiff({
        tokens: ["FTP 262W"],
        sourceText: "user: my FTP 262W today",
        summary: "## Athlete Profile\n- rode easy",
      }),
    ).toEqual(["FTP 262W"]);
  });

  it("ignores a token that never appears in the source (out of scope)", () => {
    expect(
      mustPreserveDiff({
        tokens: ["achilles"],
        sourceText: "user: my FTP is 262W",
        summary: "## Athlete Profile\n- FTP 262W",
      }),
    ).toEqual([]);
  });

  it("is case-insensitive on both sides", () => {
    expect(
      mustPreserveDiff({
        tokens: ["FTP 262W"],
        sourceText: "user: FTP 262W",
        summary: "profile: ftp 262w noted",
      }),
    ).toEqual([]);
  });
});

describe("factScore", () => {
  it("counts a repeated remembered fact once", () => {
    const verdict = { factsPreserved: Array(10).fill("F01"), factsMissing: [], fabrications: [] };
    expect(factScore(verdict, INVENTORY)).toBe(0.1);
    expect(tierJTranscriptVerdict([verdict, verdict, verdict], INVENTORY).pass).toBe(false);
  });

  it("counts distinct inventory facts and keeps scores bounded", () => {
    expect(factScore(run(10, 0), [...INVENTORY, "F01"])).toBe(1);
    expect(factScore(run(10, 0), [])).toBe(0);
  });

  it("does not credit facts also declared missing", () => {
    expect(factScore({ ...run(10, 0), factsMissing: ["F01"] }, INVENTORY)).toBe(0.9);
  });
  it("scores 9 of 10 preserved inventory ids as 0.9", () => {
    expect(factScore(run(9, 0), INVENTORY)).toBeCloseTo(0.9, 10);
  });

  it("ignores ids that are not in the inventory", () => {
    const verdict: JudgeVerdict = {
      factsPreserved: [...INVENTORY, "NOT_IN_INVENTORY"],
      factsMissing: [],
      fabrications: [],
    };
    expect(factScore(verdict, INVENTORY)).toBe(1);
  });
});

describe("tierJTranscriptVerdict", () => {
  it("passes when the median fact score is 0.9 and fabrication medians are 0", () => {
    const verdict = tierJTranscriptVerdict([run(10, 0), run(9, 0), run(8, 0)], INVENTORY);
    expect(verdict.medianFactScore).toBeCloseTo(0.9, 10);
    expect(verdict.medianFabrications).toBe(0);
    expect(verdict.pass).toBe(true);
  });

  it("fails when the median fact score falls to 0.8", () => {
    const verdict = tierJTranscriptVerdict([run(8, 0), run(8, 0), run(10, 0)], INVENTORY);
    expect(verdict.medianFactScore).toBeCloseTo(0.8, 10);
    expect(verdict.pass).toBe(false);
  });

  it("fails when the median fabrication count is 1 (deliberate-failure case)", () => {
    const verdict = tierJTranscriptVerdict([run(10, 0), run(10, 1), run(10, 1)], INVENTORY);
    expect(verdict.medianFabrications).toBe(1);
    expect(verdict.pass).toBe(false);
  });
});

describe("cacheEvidence", () => {
  it("is ok when the first call writes cache and a later call reads it", () => {
    expect(cacheEvidence([compactLine(5000, 0), compactLine(0, 4800)]).ok).toBe(true);
  });

  it("is not ok when no later call reads from cache", () => {
    expect(cacheEvidence([compactLine(5000, 0), compactLine(0, 0)]).ok).toBe(false);
  });

  it("is not ok with a single compact line (no second call)", () => {
    expect(cacheEvidence([compactLine(5000, 0)]).ok).toBe(false);
  });
});

describe("parseJudgeVerdict", () => {
  it.each([null, 1, {}, ["F01", 2], [""], ["   "]])(
    "rejects malformed field values: %j",
    (value) => {
      for (const field of ["factsPreserved", "factsMissing", "fabrications"]) {
        expect(() =>
          parseJudgeVerdict(JSON.stringify({ ...run(1, 0), [field]: value }), INVENTORY),
        ).toThrow();
      }
    },
  );

  it("rejects contradictory preserved and missing facts", () => {
    expect(() =>
      parseJudgeVerdict(JSON.stringify({ ...run(1, 0), factsMissing: ["F01"] }), INVENTORY),
    ).toThrow(/both preserved and missing/);
  });

  it.each(["factsPreserved", "factsMissing"])("rejects unknown IDs in %s", (field) => {
    expect(() =>
      parseJudgeVerdict(JSON.stringify({ ...run(1, 0), [field]: ["UNKNOWN"] }), INVENTORY),
    ).toThrow(/unknown fact ID/);
  });

  it("deduplicates valid declarations", () => {
    expect(
      parseJudgeVerdict(
        JSON.stringify({
          factsPreserved: ["F01", "F01"],
          factsMissing: ["F02", "F02"],
          fabrications: [],
        }),
        INVENTORY,
      ),
    ).toEqual({ factsPreserved: ["F01"], factsMissing: ["F02"], fabrications: [] });
  });
  it("parses a clean JSON reply", () => {
    const v = parseJudgeVerdict(
      '{"factsPreserved":["F01"],"factsMissing":[],"fabrications":[]}',
      INVENTORY,
    );
    expect(v.factsPreserved).toEqual(["F01"]);
  });

  it("extracts JSON wrapped in prose", () => {
    const v = parseJudgeVerdict(
      'Here is my verdict:\n{"factsPreserved":[],"factsMissing":["F01"],"fabrications":["made up a number"]}\nDone.',
      INVENTORY,
    );
    expect(v.factsMissing).toEqual(["F01"]);
    expect(v.fabrications).toEqual(["made up a number"]);
  });

  it("throws on garbage", () => {
    expect(() => parseJudgeVerdict("no json here", INVENTORY)).toThrow();
  });
});

describe("median", () => {
  it("returns the middle value of an odd-length array", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe("drawsVerdict", () => {
  it("passes on a strict majority of passing draws", () => {
    expect(drawsVerdict([true, true, false])).toBe(true);
  });

  it("fails when only a minority of draws pass (deliberate-failure case)", () => {
    expect(drawsVerdict([true, false, false])).toBe(false);
  });

  it("fails on an exact tie (no strict majority)", () => {
    expect(drawsVerdict([true, false])).toBe(false);
  });
});
