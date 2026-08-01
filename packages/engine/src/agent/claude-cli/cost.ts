import type { UsageCost } from "../../host-ports.js";
import type { UsageTokenCounts } from "../../usage-cost.js";

export interface ClaudeCliModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const CLAUDE_CLI_FALLBACK_PRICE_ID = "sonnet";

export const CLAUDE_CLI_PRICE_TABLE: Record<string, ClaudeCliModelCost> = {
  "sonnet": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function resolveClaudeCliPriceId(modelId: string): string {
  if (CLAUDE_CLI_PRICE_TABLE[modelId] !== undefined) return modelId;
  const family = modelId.toLowerCase();
  if (family.includes("opus")) return "opus";
  if (family.includes("haiku")) return "haiku";
  return CLAUDE_CLI_FALLBACK_PRICE_ID;
}

export function claudeCliRates(modelId: string): ClaudeCliModelCost {
  return (
    CLAUDE_CLI_PRICE_TABLE[resolveClaudeCliPriceId(modelId)] ??
    CLAUDE_CLI_PRICE_TABLE[CLAUDE_CLI_FALLBACK_PRICE_ID]
  );
}

function validTokenCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function priceClaudeCliInclusiveUsage(
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
  const rates = claudeCliRates(modelId);
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
