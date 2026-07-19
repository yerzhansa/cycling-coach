import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageLedgerLine } from "@enduragent/engine";
import {
  DAILY_SPEND_CAP_FILE,
  DEFAULT_DAILY_SPEND_CAP_USD,
  createSpendMeterService,
} from "../src/spend-meter.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "spend-meter-"));
  configDir = join(root, "config");
  await mkdir(configDir, { mode: 0o700 });
});

afterEach(async () => {
  await chmod(configDir, 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

function line(overrides: Partial<UsageLedgerLine> = {}): UsageLedgerLine {
  return {
    ts: Date.UTC(1998, 6, 6, 12),
    kind: "generate",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    durationMs: 10,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    ...overrides,
  };
}

async function ledger(file: string, values: readonly (UsageLedgerLine | string)[]): Promise<void> {
  await writeFile(
    join(root, file),
    values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n") +
      "\n",
  );
}

describe("spend meter service", () => {
  it("aggregates rotated and live generations once with native precedence and honest gaps", async () => {
    await ledger("usage-ledger.jsonl.1", [
      line({
        providerReportedCostUsd: 0.02,
        cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 },
      }),
      line({ kind: "turn", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, total: 36 } }),
      "not-json",
    ]);
    await ledger("usage-ledger.jsonl", [
      line(),
      line({
        provider: "openrouter",
        model: "openrouter/auto",
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.8 },
      }),
      line({ kind: "boot" }),
    ]);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    const summary = await service.getSpendSummary();
    expect(summary).toMatchObject({
      localDate: "1998-07-06",
      dailyCapUsd: DEFAULT_DAILY_SPEND_CAP_USD,
      generationCount: 3,
      pricedGenerationCount: 2,
      unpricedGenerationCount: 1,
      malformedLineCount: 1,
      spendComplete: false,
      capStatus: "unknown",
      cacheReadTokens: 800,
      knownCacheReadSavingsUsd: 0.00216,
      cacheSavingsComplete: false,
    });
    expect(summary.knownSpendUsd).toBeCloseTo(0.023495, 12);
    expect(summary.routes.map(({ provider, model }) => [provider, model])).toEqual([
      ["anthropic", "claude-sonnet-4-6"],
      ["openrouter", "openrouter/auto"],
    ]);
    expect(summary.routes[0]).toMatchObject({
      generationCount: 2,
      providerReportedGenerationCount: 1,
      caching: "explicit",
      disclosure: null,
    });
    expect(summary.routes[1]).toMatchObject({
      knownSpendUsd: 0,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 1,
      caching: "provider-dependent",
      cacheReadSavingsUsd: 0,
    });
  });

  it("uses the athlete timezone boundary, including a daylight-saving zone, and captures now once", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ ts: Date.UTC(1998, 6, 6, 6, 30), providerReportedCostUsd: 0.1 }),
      line({ ts: Date.UTC(1998, 6, 6, 8, 30), providerReportedCostUsd: 0.2 }),
    ]);
    let calls = 0;
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "America/Los_Angeles",
      now: () => {
        calls += 1;
        return Date.UTC(1998, 6, 6, 8);
      },
    });
    const summary = await service.getSpendSummary();
    expect(summary.localDate).toBe("1998-07-06");
    expect(summary.generationCount).toBe(1);
    expect(summary.knownSpendUsd).toBe(0.2);
    expect(calls).toBe(1);
  });

  it("persists a strict mode-0600 cap and uses the known lower bound for reached status", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ providerReportedCostUsd: 0.03 }),
      line({
        provider: "synthetic",
        model: "unpriced",
        inputTokens: undefined,
        outputTokens: undefined,
      }),
    ]);
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    const summary = await service.setDailySpendCap(0.02);
    expect(summary.capStatus).toBe("reached");
    expect(summary.spendComplete).toBe(false);
    const path = join(configDir, DAILY_SPEND_CAP_FILE);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, dailyCapUsd: 0.02 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(service.setDailySpendCap(0)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, dailyCapUsd: 0.02 });
  });

  it("preserves the prior cap when an atomic replacement cannot be staged", async () => {
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    await service.setDailySpendCap(0.4);
    const path = join(configDir, DAILY_SPEND_CAP_FILE);
    await chmod(configDir, 0o500);
    await expect(service.setDailySpendCap(0.8)).rejects.toThrow();
    await chmod(configDir, 0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, dailyCapUsd: 0.4 });
  });

  it("falls back on missing, malformed, wrong-version, and extra-field cap files", async () => {
    const service = createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    });
    expect((await service.getSpendSummary()).dailyCapUsd).toBe(0.5);
    for (const value of [
      "not-json",
      JSON.stringify({ version: 2, dailyCapUsd: 1 }),
      JSON.stringify({ version: 1, dailyCapUsd: -1 }),
      JSON.stringify({ version: 1, dailyCapUsd: 1, extra: true }),
    ]) {
      await writeFile(join(configDir, DAILY_SPEND_CAP_FILE), value);
      expect((await service.getSpendSummary()).dailyCapUsd).toBe(0.5);
    }
  });

  it("counts invalid selected numeric fields as malformed unpriced generations", async () => {
    await ledger("usage-ledger.jsonl", [
      line({ providerReportedCostUsd: -1 }),
      line({ inputTokens: 1.5 }),
    ]);
    const summary = await createSpendMeterService({
      dataDir: root,
      configDir,
      timezone: "UTC",
      now: () => Date.UTC(1998, 6, 6, 18),
    }).getSpendSummary();
    expect(summary).toMatchObject({
      generationCount: 2,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 2,
      malformedLineCount: 2,
      knownSpendUsd: 0,
      capStatus: "unknown",
    });
  });
});
