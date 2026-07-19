import type { SpendCaching } from "@enduragent/coach-contract";
import { PRICE_TABLE, isPriced, priceUsage } from "./agent/codex/cost.js";
import type { UsageCost } from "./host-ports.js";

export interface UsageTokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function validTokenCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function rates(provider: string, model: string) {
  if (!isPriced(provider, model)) return undefined;
  const value = PRICE_TABLE[provider]?.[model];
  if (
    value === undefined ||
    ![value.input, value.output, value.cacheRead, value.cacheWrite].every(
      (rate) => Number.isFinite(rate) && rate >= 0,
    )
  ) {
    return undefined;
  }
  return value;
}

function validCost(value: UsageCost | undefined): value is UsageCost {
  return (
    value !== undefined &&
    [value.input, value.output, value.cacheRead, value.cacheWrite, value.total].every(
      (dimension) => Number.isFinite(dimension) && dimension >= 0,
    )
  );
}

export function priceInclusiveUsage(
  provider: string,
  model: string,
  usage: UsageTokenCounts,
): UsageCost | undefined {
  if (
    !validTokenCount(usage.inputTokens) ||
    !validTokenCount(usage.outputTokens) ||
    !validTokenCount(usage.cacheReadTokens) ||
    !validTokenCount(usage.cacheWriteTokens) ||
    rates(provider, model) === undefined
  ) {
    return undefined;
  }
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const priced = priceUsage(provider, model, {
    input: uncachedInputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
  });
  return validCost(priced) ? priced : undefined;
}

export function cacheReadSavingsUsd(
  provider: string,
  model: string,
  cacheReadTokens: number,
): number | null {
  if (!validTokenCount(cacheReadTokens)) return null;
  const catalog = rates(provider, model);
  if (catalog === undefined) return null;
  const savings = (Math.max(0, catalog.input - catalog.cacheRead) * cacheReadTokens) / 1_000_000;
  return Number.isFinite(savings) && savings >= 0 ? savings : null;
}

export function classifySpendCaching(provider: string, model: string): SpendCaching {
  if (provider === "anthropic") return "explicit";
  if (provider === "openrouter" && model.startsWith("qwen/")) return "explicit";
  if (
    provider === "openrouter" &&
    (model.startsWith("anthropic/") || model.startsWith("google/"))
  ) {
    return "unavailable";
  }
  return "provider-dependent";
}
