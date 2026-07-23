import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CACHING_UNAVAILABLE_DISCLOSURE,
  SetDailySpendCapRpcParamsSchema,
  SpendSummarySchema,
  type SpendRouteSummary,
  type SpendSummary,
} from "@enduragent/coach-contract";
import { atomicWriteJson, readUsageLedger } from "@enduragent/core";
import {
  cacheReadSavingsUsd,
  classifySpendCaching,
  priceInclusiveUsage,
  type UsageLedgerLine,
} from "@enduragent/engine";
import { z } from "zod";

export const DEFAULT_DAILY_SPEND_CAP_USD = 0.5;
export const DAILY_SPEND_CAP_FILE = "daily-spend-cap.json";
export const DAILY_SPEND_CAP_VERSION = 1;

export interface SpendMeterService {
  getSpendSummary(): Promise<SpendSummary>;
  setDailySpendCap(dailyCapUsd: number): Promise<SpendSummary>;
}

export interface CreateSpendMeterServiceInput {
  readonly dataDir: string;
  readonly configDir: string;
  readonly timezone: string;
  readonly now?: () => number;
}

const DailySpendCapSchema = z
  .object({
    version: z.literal(DAILY_SPEND_CAP_VERSION),
    dailyCapUsd: z.number().finite().positive(),
  })
  .strict();

interface MutableRoute {
  readonly provider: string;
  readonly model: string;
  generationCount: number;
  pricedGenerationCount: number;
  unpricedGenerationCount: number;
  providerReportedGenerationCount: number;
  knownSpendUsd: number;
  cacheReadTokens: number;
  cacheSavingsKnownUsd: number;
  cacheSavingsAvailable: boolean;
}

function dateKey(timestamp: number, timezone: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    if (values.year === undefined || values.month === undefined || values.day === undefined) {
      return undefined;
    }
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return undefined;
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validProviderCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeTokenSum(...values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!validToken(value)) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function catalogInputTokens(line: UsageLedgerLine): number | undefined {
  const inputTokens = line.inputTokens;
  if (line.provider !== "openai-codex" || inputTokens === undefined) return inputTokens;

  // Older Codex rows stored uncached input while retaining the provider's
  // inclusive total. Only that exact identity can distinguish them safely
  // from current rows without rewriting the ledger.
  const { outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } = line;
  if (
    outputTokens === undefined ||
    totalTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return inputTokens;
  }

  const cachedInputTokens = safeTokenSum(cacheReadTokens, cacheWriteTokens);
  if (cachedInputTokens === undefined || cachedInputTokens === 0) return inputTokens;

  const legacyTotalTokens = safeTokenSum(inputTokens, cachedInputTokens, outputTokens);
  if (legacyTotalTokens !== totalTokens) return inputTokens;

  return safeTokenSum(inputTokens, cachedInputTokens) ?? inputTokens;
}

function readDailyCap(path: string): number {
  try {
    return DailySpendCapSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown).dailyCapUsd;
  } catch {
    return DEFAULT_DAILY_SPEND_CAP_USD;
  }
}

function selectedNumericFieldsValid(line: Record<string, unknown>): boolean {
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    if (line[field] !== undefined && !validToken(line[field])) return false;
  }
  return (
    line.providerReportedCostUsd === undefined || validProviderCost(line.providerReportedCostUsd)
  );
}

function routeSummary(route: MutableRoute): SpendRouteSummary {
  const caching = classifySpendCaching(route.provider, route.model);
  return {
    provider: route.provider,
    model: route.model,
    generationCount: route.generationCount,
    pricedGenerationCount: route.pricedGenerationCount,
    unpricedGenerationCount: route.unpricedGenerationCount,
    providerReportedGenerationCount: route.providerReportedGenerationCount,
    knownSpendUsd: route.knownSpendUsd,
    cacheReadTokens: route.cacheReadTokens,
    cacheReadSavingsUsd: route.cacheSavingsAvailable ? route.cacheSavingsKnownUsd : null,
    caching,
    disclosure: caching === "unavailable" ? CACHING_UNAVAILABLE_DISCLOSURE : null,
  };
}

export function createSpendMeterService(input: CreateSpendMeterServiceInput): SpendMeterService {
  const now = input.now ?? Date.now;
  const capPath = join(input.configDir, DAILY_SPEND_CAP_FILE);

  const summarize = async (): Promise<SpendSummary> => {
    const capturedNow = now();
    const localDate = dateKey(capturedNow, input.timezone);
    if (localDate === undefined) throw new TypeError("Spend date could not be resolved.");
    const dailyCapUsd = readDailyCap(capPath);
    const ledger = readUsageLedger(input.dataDir);
    let malformedLineCount = ledger.malformedLineCount;
    const routes = new Map<string, MutableRoute>();

    for (const rawLine of ledger.lines) {
      const line = rawLine as UsageLedgerLine & Record<string, unknown>;
      if (
        !["generate", "turn", "boot"].includes(String(line.kind)) ||
        typeof line.ts !== "number" ||
        !Number.isFinite(line.ts) ||
        !nonemptyString(line.provider) ||
        !nonemptyString(line.model)
      ) {
        malformedLineCount += 1;
        continue;
      }
      const lineDate = dateKey(line.ts, input.timezone);
      if (lineDate === undefined) {
        malformedLineCount += 1;
        continue;
      }
      if (line.kind !== "generate" || lineDate !== localDate) continue;

      const key = JSON.stringify([line.provider, line.model]);
      const route = routes.get(key) ?? {
        provider: line.provider,
        model: line.model,
        generationCount: 0,
        pricedGenerationCount: 0,
        unpricedGenerationCount: 0,
        providerReportedGenerationCount: 0,
        knownSpendUsd: 0,
        cacheReadTokens: 0,
        cacheSavingsKnownUsd: 0,
        cacheSavingsAvailable: true,
      };
      routes.set(key, route);
      route.generationCount += 1;

      if (!selectedNumericFieldsValid(line)) {
        malformedLineCount += 1;
        route.unpricedGenerationCount += 1;
        continue;
      }

      const cacheReadTokens = line.cacheReadTokens ?? 0;
      const nextCacheReadTokens = route.cacheReadTokens + cacheReadTokens;
      if (!Number.isSafeInteger(nextCacheReadTokens)) {
        malformedLineCount += 1;
        route.unpricedGenerationCount += 1;
        route.cacheSavingsAvailable = false;
        continue;
      }
      route.cacheReadTokens = nextCacheReadTokens;
      if (cacheReadTokens > 0) {
        const savings = cacheReadSavingsUsd(line.provider, line.model, cacheReadTokens);
        if (savings === null || !Number.isFinite(route.cacheSavingsKnownUsd + savings)) {
          route.cacheSavingsAvailable = false;
        } else {
          route.cacheSavingsKnownUsd += savings;
        }
      }

      const providerReported = line.providerReportedCostUsd;
      const catalogCost =
        providerReported === undefined &&
        line.inputTokens !== undefined &&
        line.outputTokens !== undefined
          ? priceInclusiveUsage(line.provider, line.model, {
              inputTokens: catalogInputTokens(line) ?? line.inputTokens,
              outputTokens: line.outputTokens,
              cacheReadTokens,
              cacheWriteTokens: line.cacheWriteTokens ?? 0,
            })
          : undefined;
      const cost = providerReported ?? catalogCost?.total;
      if (cost === undefined || !Number.isFinite(route.knownSpendUsd + cost)) {
        route.unpricedGenerationCount += 1;
      } else {
        route.knownSpendUsd += cost;
        route.pricedGenerationCount += 1;
        if (providerReported !== undefined) route.providerReportedGenerationCount += 1;
      }
    }

    const sortedRoutes = [...routes.values()]
      .sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
      )
      .map(routeSummary);
    const generationCount = sortedRoutes.reduce((sum, route) => sum + route.generationCount, 0);
    const pricedGenerationCount = sortedRoutes.reduce(
      (sum, route) => sum + route.pricedGenerationCount,
      0,
    );
    const unpricedGenerationCount = sortedRoutes.reduce(
      (sum, route) => sum + route.unpricedGenerationCount,
      0,
    );
    const knownSpendUsd = sortedRoutes.reduce((sum, route) => sum + route.knownSpendUsd, 0);
    const cacheReadTokens = sortedRoutes.reduce((sum, route) => sum + route.cacheReadTokens, 0);
    const knownCacheReadSavingsUsd = sortedRoutes.reduce(
      (sum, route) => sum + (route.cacheReadSavingsUsd ?? 0),
      0,
    );
    const spendComplete = unpricedGenerationCount === 0 && malformedLineCount === 0;
    const cacheSavingsComplete =
      malformedLineCount === 0 && sortedRoutes.every((route) => route.cacheReadSavingsUsd !== null);
    return SpendSummarySchema.parse({
      localDate,
      timezone: input.timezone,
      dailyCapUsd,
      knownSpendUsd,
      generationCount,
      pricedGenerationCount,
      unpricedGenerationCount,
      malformedLineCount,
      spendComplete,
      capStatus: knownSpendUsd >= dailyCapUsd ? "reached" : spendComplete ? "below" : "unknown",
      cacheReadTokens,
      knownCacheReadSavingsUsd,
      cacheSavingsComplete,
      routes: sortedRoutes,
    });
  };

  return {
    getSpendSummary: summarize,
    async setDailySpendCap(dailyCapUsd) {
      const parsed = SetDailySpendCapRpcParamsSchema.parse({ dailyCapUsd });
      await atomicWriteJson(capPath, {
        version: DAILY_SPEND_CAP_VERSION,
        dailyCapUsd: parsed.dailyCapUsd,
      });
      return summarize();
    },
  };
}
