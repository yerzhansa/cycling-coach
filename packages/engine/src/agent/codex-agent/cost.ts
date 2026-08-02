import type { UsageCost } from "../../host-ports.js";
import type { UsageTokenCounts } from "../../usage-cost.js";

export interface CodexAgentModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const CODEX_AGENT_FALLBACK_PRICE_ID = "gpt-5.6-sol";

export const CODEX_AGENT_PRICE_TABLE: Record<string, CodexAgentModelCost> = {
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
};

export function resolveCodexAgentPriceId(modelId: string): string {
  if (CODEX_AGENT_PRICE_TABLE[modelId] !== undefined) return modelId;
  const family = modelId.toLowerCase();
  if (family.includes("terra")) return "gpt-5.6-terra";
  if (family.includes("luna")) return "gpt-5.6-luna";
  return CODEX_AGENT_FALLBACK_PRICE_ID;
}

export function codexAgentRates(modelId: string): CodexAgentModelCost {
  return (
    CODEX_AGENT_PRICE_TABLE[resolveCodexAgentPriceId(modelId)] ??
    CODEX_AGENT_PRICE_TABLE[CODEX_AGENT_FALLBACK_PRICE_ID]
  );
}

function validTokenCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function codexAgentCacheReadSavingsUsd(
  modelId: string,
  cacheReadTokens: number,
): number | null {
  if (!validTokenCount(cacheReadTokens)) return null;
  const rates = codexAgentRates(modelId);
  const savings = (Math.max(0, rates.input - rates.cacheRead) * cacheReadTokens) / 1_000_000;
  return Number.isFinite(savings) && savings >= 0 ? savings : null;
}

export function priceCodexAgentInclusiveUsage(
  modelId: string,
  usage: UsageTokenCounts,
): UsageCost | undefined {
  if (
    !validTokenCount(usage.inputTokens) ||
    !validTokenCount(usage.outputTokens) ||
    !validTokenCount(usage.cacheReadTokens) ||
    !validTokenCount(usage.cacheWriteTokens)
  ) {
    return undefined;
  }
  const rates = codexAgentRates(modelId);
  const uncachedInputTokens = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const input = (rates.input / 1_000_000) * uncachedInputTokens;
  const output = (rates.output / 1_000_000) * usage.outputTokens;
  const cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheReadTokens;
  const cacheWrite = (rates.cacheWrite / 1_000_000) * usage.cacheWriteTokens;
  const total = input + output + cacheRead + cacheWrite;
  return [input, output, cacheRead, cacheWrite, total].every(
    (dimension) => Number.isFinite(dimension) && dimension >= 0,
  )
    ? { input, output, cacheRead, cacheWrite, total }
    : undefined;
}
