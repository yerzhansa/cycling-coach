import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import type { UsageLedgerLine } from "../packages/core/src/usage-ledger.js";
import type { ModelCost } from "../packages/core/src/agent/codex/cost.js";
import {
  parseCli,
  parsePriceFlag,
  loadLedger,
  recomputeLineCostUsd,
  isBreakpointCapableChatLine,
  buildBandReport,
  verdictExitCode,
  type BandReport,
} from "./usage-cache-band.js";

const T0 = 888_888_888_888;
const DAY = 86_400_000;

function line(over: Partial<UsageLedgerLine>): UsageLedgerLine {
  return {
    ts: T0,
    kind: "generate",
    caller: "chat",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 5000,
    ...over,
  };
}

function jsonl(lines: UsageLedgerLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function report(
  raw: string,
  opts: { sinceTs?: number | null; priceOverrides?: ReadonlyMap<string, ModelCost> } = {},
): BandReport {
  return buildBandReport({
    ledgerPaths: ["/ledger"],
    ledgerSource: "test",
    raw,
    sinceTs: opts.sinceTs ?? null,
    priceOverrides: opts.priceOverrides ?? new Map<string, ModelCost>(),
  });
}

// ─── 1. parseCli ────────────────────────────────────────────────────────

describe("parseCli", () => {
  it("defaults to json=false with an empty overrides map", () => {
    expect(parseCli([])).toEqual({ priceOverrides: new Map(), json: false });
  });
  it("accepts --flag value and --flag=value spellings", () => {
    expect(parseCli(["--ledger", "/tmp/a.jsonl"])).toMatchObject({ ledger: "/tmp/a.jsonl" });
    expect(parseCli(["--ledger=/tmp/b.jsonl", "--json"])).toMatchObject({
      ledger: "/tmp/b.jsonl",
      json: true,
    });
  });
  it("throws when --ledger and --data-dir are both given", () => {
    expect(() => parseCli(["--ledger", "/a", "--data-dir", "/b"])).toThrow(/mutually exclusive/);
  });
  it("parses --since as epoch ms and as ISO-8601, rejects nonsense", () => {
    expect(parseCli(["--since", "888888888888"]).sinceTs).toBe(888_888_888_888);
    expect(parseCli(["--since", "1998-03-03T01:34:48.888Z"]).sinceTs).toBe(888_888_888_888);
    expect(() => parseCli(["--since", "nonsense"])).toThrow(/--since/);
  });
  it("rejects an inline value on --json and unknown flags", () => {
    expect(() => parseCli(["--json=false"])).toThrow(/takes no value/);
    expect(() => parseCli(["--nope"])).toThrow(/unknown flag/);
  });
});

// ─── 2. parsePriceFlag ────────────────────────────────────────────────────

describe("parsePriceFlag", () => {
  it("parses a provider:model=four-numbers grammar with a model that contains /", () => {
    const { key, price } = parsePriceFlag("openrouter:qwen/qwen3.5-plus=0.26/1.56/0.026/0.325");
    expect(key).toBe("openrouter:qwen/qwen3.5-plus");
    expect(price).toEqual({ input: 0.26, output: 1.56, cacheRead: 0.026, cacheWrite: 0.325 });
  });
  it("throws on every malformed shape", () => {
    expect(() => parsePriceFlag("openrouter:qwen/qwen3.5-plus0.26/1.56/0.026/0.325")).toThrow(); // missing =
    expect(() => parsePriceFlag("openrouterqwen=0.26/1.56/0.026/0.325")).toThrow(); // missing :
    expect(() => parsePriceFlag("a:b=1/2/3")).toThrow(); // three numbers
    expect(() => parsePriceFlag("a:b=1/2/3/4/5")).toThrow(); // five numbers
    expect(() => parsePriceFlag("a:b=1/x/3/4")).toThrow(); // non-numeric
    expect(() => parsePriceFlag("a:b=-1/2/3/4")).toThrow(); // negative
  });
  it("accumulates repeatable --price into the overrides map", () => {
    const args = parseCli(["--price", "a:b=1/2/3/4", "--price", "c:d=5/6/7/8"]);
    expect(args.priceOverrides.size).toBe(2);
    expect(args.priceOverrides.get("a:b")).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });
});

// ─── 3. recomputeLineCostUsd ──────────────────────────────────────────────

describe("recomputeLineCostUsd", () => {
  const noOverrides = new Map<string, ModelCost>();
  it("prices a sonnet line at the clamp boundary (uncached input = 0)", () => {
    const c = recomputeLineCostUsd(
      line({ inputTokens: 60000, outputTokens: 1000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }),
      noOverrides,
    );
    expect(c).toBeCloseTo(0.0606, 10);
  });
  it("clamps uncached input to 0 (never a negative cost) when cache exceeds input", () => {
    const c = recomputeLineCostUsd(
      line({ inputTokens: 10000, cacheReadTokens: 9000, cacheWriteTokens: 5000 }),
      noOverrides,
    );
    expect(c).toBeGreaterThanOrEqual(0);
  });
  it("returns null for an unknown provider/model", () => {
    expect(recomputeLineCostUsd(line({ provider: "nope", model: "nope" }), noOverrides)).toBeNull();
  });
  it("lets an override win over a catalog entry", () => {
    const overrides = new Map<string, ModelCost>([
      ["anthropic:claude-sonnet-4-6", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    ]);
    expect(
      recomputeLineCostUsd(line({ inputTokens: 60000, outputTokens: 1000, cacheReadTokens: 0 }), overrides),
    ).toBe(0);
  });
});

// ─── 4. isBreakpointCapableChatLine ───────────────────────────────────────

describe("isBreakpointCapableChatLine", () => {
  it("is true for anthropic chat and openrouter qwen/ chat, false otherwise", () => {
    expect(isBreakpointCapableChatLine(line({ inputTokens: 100 }))).toBe(true);
    expect(
      isBreakpointCapableChatLine(line({ provider: "openrouter", model: "qwen/qwen3.5-plus", inputTokens: 100 })),
    ).toBe(true);
    expect(
      isBreakpointCapableChatLine(line({ provider: "openrouter", model: "deepseek/deepseek-v4-flash", inputTokens: 100 })),
    ).toBe(false);
    expect(
      isBreakpointCapableChatLine(line({ provider: "openai-codex", model: "gpt-5.1-codex-mini", inputTokens: 100 })),
    ).toBe(false);
    expect(isBreakpointCapableChatLine(line({ caller: "flush", inputTokens: 100 }))).toBe(false);
    expect(isBreakpointCapableChatLine(line({ kind: "turn", inputTokens: 100 }))).toBe(false);
    expect(isBreakpointCapableChatLine(line({ inputTokens: 0 }))).toBe(false);
    expect(isBreakpointCapableChatLine(line({ inputTokens: undefined }))).toBe(false);
  });
});

// ─── 5. Route scoping bites ───────────────────────────────────────────────

describe("route scoping", () => {
  it("excludes uncached-route chat lines from the scoped ratio but not from allRoutesChatRatio", () => {
    const lines: UsageLedgerLine[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(line({ ts: T0 + i * DAY, inputTokens: 60000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }));
    }
    lines.push(
      line({ ts: T0, provider: "openai-codex", model: "gpt-5.1-codex-mini", inputTokens: 500000, cacheReadTokens: 0 }),
    );
    const r = report(jsonl(lines));
    expect(r.cacheHit.eligibleLines).toBe(8);
    expect(r.cacheHit.ratio).toBeCloseTo(416000 / 480000, 10);
    expect(r.cacheHit.ratio!).toBeGreaterThanOrEqual(0.6);
    expect(r.cacheHit.allRoutesChatRatio!).toBeLessThan(0.6);
  });
});

// ─── 6. Kind exclusion ────────────────────────────────────────────────────

describe("kind exclusion", () => {
  it("turn and boot lines contribute to no sum", () => {
    const base = [
      line({ ts: T0, inputTokens: 60000, outputTokens: 1000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }),
      line({ ts: T0 + DAY, inputTokens: 60000, outputTokens: 1000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }),
    ];
    const withNoise = [
      ...base,
      line({ ts: T0 + 2 * DAY, kind: "turn", inputTokens: 99999, outputTokens: 9999, cacheReadTokens: 1 }),
      line({ ts: T0 + 3 * DAY, kind: "boot", caller: undefined }),
    ];
    const a = report(jsonl(base));
    const b = report(jsonl(withNoise));
    expect(b.dailyCost.generateLines).toBe(a.dailyCost.generateLines);
    expect(b.cacheHit.eligibleLines).toBe(a.cacheHit.eligibleLines);
    expect(b.dailyCost.recomputedTotalUsd).toBeCloseTo(a.dailyCost.recomputedTotalUsd, 10);
  });
});

// ─── 7. Unknown-caller forward compatibility ──────────────────────────────

describe("unknown caller forward-compat", () => {
  it("counts an out-of-union caller in generateLines but not eligibleLines", () => {
    const raw =
      jsonl([line({ inputTokens: 60000, cacheReadTokens: 52000, cacheWriteTokens: 8000 })]) +
      '{"ts":888888888888,"kind":"generate","caller":"batch-eval","provider":"anthropic","model":"claude-sonnet-4-6","durationMs":5000,"inputTokens":1000,"outputTokens":100}';
    const r = report(raw);
    expect(r.dailyCost.generateLines).toBe(2);
    expect(r.cacheHit.eligibleLines).toBe(1);
  });
});

// ─── 8. Inclusivity violation ─────────────────────────────────────────────

describe("inclusivity violation", () => {
  it("flags a line whose cache tokens exceed inputTokens and returns UNDETERMINED", () => {
    const lines: UsageLedgerLine[] = [];
    for (let i = 0; i < 7; i++) {
      lines.push(line({ ts: T0 + i * DAY, inputTokens: 20000, cacheReadTokens: 15000, cacheWriteTokens: 0 }));
    }
    lines.push(line({ ts: T0 + 7 * DAY, inputTokens: 20000, cacheReadTokens: 15000, cacheWriteTokens: 10000 }));
    const r = report(jsonl(lines));
    expect(r.cacheHit.ratio!).toBeGreaterThanOrEqual(0.6);
    expect(r.cacheHit.inclusivityViolations).toBe(1);
    expect(r.verdict).toBe("UNDETERMINED");
    expect(r.undeterminedReasons).toContain("inclusivity-violation");
  });
});

// ─── 9. Window + soak boundary ────────────────────────────────────────────

describe("soak window boundary", () => {
  it("is soak-complete at exactly 7.00 days and incomplete 1 ms below", () => {
    const daily = (lastTs: number): UsageLedgerLine[] => {
      const lines: UsageLedgerLine[] = [];
      for (let i = 0; i < 7; i++) {
        lines.push(line({ ts: T0 + i * DAY, inputTokens: 60000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }));
      }
      lines.push(line({ ts: lastTs, inputTokens: 60000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }));
      return lines;
    };
    const exact = report(jsonl(daily(T0 + 7 * DAY)));
    expect(exact.soakComplete).toBe(true);

    const short = report(jsonl(daily(T0 + 7 * DAY - 1)));
    expect(short.soakComplete).toBe(false);
    expect(short.verdict).toBe("UNDETERMINED");
    expect(short.undeterminedReasons).toContain("soak-window-below-minimum");
  });
});

// ─── 10. --since filtering ────────────────────────────────────────────────

describe("--since filtering", () => {
  it("excludes a pre-since line from the window, ratios, and cost; keeps a line exactly at sinceTs", () => {
    const lines: UsageLedgerLine[] = [
      line({ ts: T0 - DAY, inputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ];
    for (let i = 0; i < 8; i++) {
      lines.push(line({ ts: T0 + i * DAY, inputTokens: 60000, cacheReadTokens: 52000, cacheWriteTokens: 8000 }));
    }
    const raw = jsonl(lines);
    const filtered = report(raw, { sinceTs: T0 });
    expect(filtered.cacheHit.eligibleLines).toBe(8);
    expect(filtered.cacheHit.sumInputTokens).toBe(480000);

    const unfiltered = report(raw);
    expect(unfiltered.cacheHit.eligibleLines).toBe(9);
    expect(unfiltered.cacheHit.sumInputTokens).toBe(1480000);
  });
});

// ─── 11. Verdict precedence ───────────────────────────────────────────────

describe("verdict precedence", () => {
  const daily = (over: Partial<UsageLedgerLine>): UsageLedgerLine[] => {
    const lines: UsageLedgerLine[] = [];
    for (let i = 0; i < 8; i++) lines.push(line({ ts: T0 + i * DAY, ...over }));
    return lines;
  };
  it("(a) determinate below-band ratio + 100% unpriced -> REPRICE (ratio bound outranks cost uncertainty)", () => {
    const r = report(
      jsonl(daily({ provider: "openrouter", model: "qwen/qwen3.5-plus", inputTokens: 20000, cacheReadTokens: 2000 })),
    );
    expect(r.verdict).toBe("REPRICE");
  });
  it("(b) above-band ratio + unpriced share > 0.1 -> UNDETERMINED", () => {
    const r = report(
      jsonl(daily({ provider: "openrouter", model: "qwen/qwen3.5-plus", inputTokens: 20000, cacheReadTokens: 15000 })),
    );
    expect(r.verdict).toBe("UNDETERMINED");
    expect(r.undeterminedReasons).toContain("unpriced-token-share-exceeds-threshold");
  });
  it("(c) all priced, above-band ratio, projected > $0.25/day -> REPRICE", () => {
    const r = report(
      jsonl(daily({ inputTokens: 60000, outputTokens: 1000000, cacheReadTokens: 52000, cacheWriteTokens: 8000 })),
    );
    expect(r.dailyCost.projectedUsdPerDay!).toBeGreaterThan(0.25);
    expect(r.verdict).toBe("REPRICE");
  });
  it("(d) all bounds hold -> PASS", () => {
    const r = report(
      jsonl(daily({ inputTokens: 60000, outputTokens: 1000, cacheReadTokens: 52000, cacheWriteTokens: 8000 })),
    );
    expect(r.verdict).toBe("PASS");
  });
  it("(e) zero eligible lines -> UNDETERMINED with no-eligible-chat-lines", () => {
    const r = report(jsonl(daily({ caller: "flush", inputTokens: 6000, cacheReadTokens: 0 })));
    expect(r.cacheHit.eligibleLines).toBe(0);
    expect(r.verdict).toBe("UNDETERMINED");
    expect(r.undeterminedReasons).toContain("no-eligible-chat-lines");
  });
});

// ─── 12. Malformed-line resilience ────────────────────────────────────────

describe("malformed-line resilience", () => {
  it("reports over only the valid lines", () => {
    const raw =
      jsonl([line({ inputTokens: 60000, cacheReadTokens: 52000 })]) +
      "not-a-json-line\n" +
      '{"kind":"generate","provider":"anthropic","model":"claude-sonnet-4-6","durationMs":5000}\n';
    const r = report(raw);
    expect(r.linesParsed).toBe(1);
  });
});

// ─── 13. loadLedger rotation ──────────────────────────────────────────────

describe("loadLedger rotation", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  it("reads the rotated .1 file first, then the live file", () => {
    dir = mkdtempSync(join(tmpdir(), "cache-band-"));
    const live = join(dir, "usage-ledger.jsonl");
    writeFileSync(`${live}.1`, jsonl([line({ ts: T0, inputTokens: 100 })]));
    writeFileSync(live, jsonl([line({ ts: T0 + DAY, inputTokens: 200 })]));
    const loaded = loadLedger(live);
    expect(loaded.paths).toEqual([`${live}.1`, live]);
    expect(report(loaded.raw).dailyCost.generateLines).toBe(2);
  });
  it("returns a single path when only the live file exists", () => {
    dir = mkdtempSync(join(tmpdir(), "cache-band-"));
    const live = join(dir, "usage-ledger.jsonl");
    writeFileSync(live, jsonl([line({ ts: T0, inputTokens: 100 })]));
    const loaded = loadLedger(live);
    expect(loaded.paths).toEqual([live]);
  });
});

// ─── 14. End-to-end pass-fixture math ─────────────────────────────────────

describe("end-to-end pass-fixture math", () => {
  it("recomputes cost from tokens, ignoring the double-billed ledger cost field", () => {
    const lines: UsageLedgerLine[] = [
      line({ ts: 886296888888, inputTokens: 2000000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 1 }),
      line({ ts: 888888889888, kind: "boot", caller: undefined, durationMs: 1200 }),
    ];
    for (let i = 0; i < 8; i++) {
      lines.push(
        line({
          ts: T0 + i * DAY,
          steps: 3,
          inputTokens: 60000,
          outputTokens: 1000,
          cacheReadTokens: 52000,
          cacheWriteTokens: 8000,
          cost: { input: 0.18, output: 0.015, cacheRead: 0.0156, cacheWrite: 0.03, total: 0.2406 },
        }),
      );
    }
    lines.push(
      line({
        ts: 889061692488,
        caller: "flush",
        model: "claude-haiku-4-5-20251001",
        steps: 1,
        inputTokens: 6000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: { input: 0.006, output: 0.0015, cacheRead: 0, cacheWrite: 0, total: 0.0075 },
      }),
    );
    lines.push(
      line({
        ts: 889321000888,
        provider: "openai-codex",
        model: "gpt-5.1-codex-mini",
        steps: 4,
        inputTokens: 260000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
    lines.push(
      line({
        ts: 889493689000,
        kind: "turn",
        templateHash: "cafe0123deadbeef",
        inputTokens: 60000,
        outputTokens: 1000,
        cacheReadTokens: 52000,
        cacheWriteTokens: 8000,
      }),
    );
    const raw = jsonl(lines) + "not-a-json-line\n";
    const r = report(raw, { sinceTs: T0 });
    expect(r.cacheHit.sumInputTokens).toBe(480000);
    expect(r.cacheHit.sumCacheReadTokens).toBe(416000);
    expect(r.dailyCost.recomputedTotalUsd).toBeCloseTo(0.5583, 10);
    expect(r.dailyCost.projectedUsdPerDay).toBeCloseTo(0.5583 / 7, 10);
    expect(r.verdict).toBe("PASS");
  });
});

// ─── 15. verdictExitCode ──────────────────────────────────────────────────

describe("verdictExitCode", () => {
  it("maps verdicts to exit codes", () => {
    expect(verdictExitCode("PASS")).toBe(0);
    expect(verdictExitCode("REPRICE")).toBe(2);
    expect(verdictExitCode("UNDETERMINED")).toBe(3);
  });
});
