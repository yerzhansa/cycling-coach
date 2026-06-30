import { asSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import type { FinishReason, LanguageModelUsage, ModelMessage, ToolSet } from "ai";

import { getFreshToken } from "../auth/profiles.js";
import type { GenerateOpts, GenerateResult } from "../llm-types.js";
import { isNetworkError } from "./token-utils.js";
import { codexResponses } from "./codex/responses.js";
import type { CodexResponsesResult, CodexStopReason, CodexToolCall, CodexUsage } from "./codex/responses.js";
import { PRICE_TABLE, priceUsage } from "./codex/cost.js";

const DEFAULT_STEP_LIMIT = 10;

const SERVER_ERROR_HTTP_STATUSES = new Set([500, 502, 503, 504]);

// ============================================================================
// ERROR NORMALIZATION
// ============================================================================

/**
 * The codex path throws plain Errors with human messages (plus an httpStatus /
 * retryAfterMs carrier on HTTP failures, and an errno cause chain on network
 * throws). Our retry loop in agent/coach-agent.ts relies on the token-utils
 * predicates, which key off err.name and message substrings. Rewrite the error
 * so those predicates trigger without teaching them about the codex surface.
 */
export function normalizeError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const msg = err.message ?? "";
  const lower = msg.toLowerCase();
  const carried = err as Error & { httpStatus?: number; retryAfterMs?: number };

  // A thrown fetch (no Response) is a network failure — the errno lives on the
  // cause chain. Classify it first so an ETIMEDOUT connection error routes as
  // network (matching how it classified before the provider library was owned),
  // and so the outer loop's NetworkError guard still recognizes it.
  if (isNetworkError(err)) {
    const out = new Error(msg) as Error & { cause?: unknown };
    out.name = "NetworkError";
    out.cause = err.cause ?? err;
    return out;
  }

  // A transient 5xx must take the short server-error backoff, not the rate-limit
  // ramp — split it out before the rate-limit pattern.
  const status = carried.httpStatus;
  if (status !== undefined && SERVER_ERROR_HTTP_STATUSES.has(status)) {
    const out = new Error(`Server error: ${msg}`) as Error & { retryAfterMs?: number };
    out.name = "ServerError";
    if (carried.retryAfterMs !== undefined) out.retryAfterMs = carried.retryAfterMs;
    return out;
  }

  // 429 / usage limit → rate limit. The httpStatus check covers an opaque-body
  // 429; the regex covers the ChatGPT usage-limit friendly message.
  if (carried.httpStatus === 429 || /usage.?limit|rate.?limit|too many requests|429/i.test(msg)) {
    const out = new Error(`Rate limit exceeded: ${msg}`) as Error & { retryAfterMs?: number };
    out.name = "RateLimitError";
    if (carried.retryAfterMs !== undefined) out.retryAfterMs = carried.retryAfterMs;
    return out;
  }

  if (/request was aborted|timeout|timed out|deadline/i.test(lower)) {
    const out = new Error(`Request timeout: ${msg}`);
    out.name = "TimeoutError";
    return out;
  }

  if (
    /context.?length|context.?window|maximum context|token limit|too many tokens|content_too_large|exceeds the maximum/i.test(
      lower,
    )
  ) {
    const out = new Error(`Context overflow: ${msg}`);
    out.name = "ContextOverflowError";
    return out;
  }

  return err;
}

// ============================================================================
// RESULT MAPPING
// ============================================================================

function mapStopReason(reason: CodexStopReason): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "toolUse":
      return "tool-calls";
    case "error":
      return "error";
    default:
      return "other";
  }
}

function emptyTokens(): CodexUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addTokens(acc: CodexUsage, u: CodexUsage): CodexUsage {
  return {
    input: acc.input + u.input,
    output: acc.output + u.output,
    cacheRead: acc.cacheRead + u.cacheRead,
    cacheWrite: acc.cacheWrite + u.cacheWrite,
    totalTokens: acc.totalTokens + u.totalTokens,
  };
}

function mapUsage(u: CodexUsage): LanguageModelUsage {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    totalTokens: u.totalTokens,
    reasoningTokens: undefined,
    cachedInputTokens: u.cacheRead,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
    },
    outputTokenDetails: {
      reasoningTokens: undefined,
      acceptedPredictionTokens: undefined,
      rejectedPredictionTokens: undefined,
    },
  } as unknown as LanguageModelUsage;
}

// Codex accepts model ids (e.g. "pro") that are not in the price catalog;
// upstream fell back to the gpt-5.4 template for those, so price unknown codex
// ids at gpt-5.4 rates rather than dropping to undefined.
function resolveCodexPriceId(modelId: string): string {
  return PRICE_TABLE["openai-codex"]?.[modelId] ? modelId : "gpt-5.4";
}

// ============================================================================
// TOOL EXECUTION
// ============================================================================

interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text" | "error-text"; value: string };
}

async function executeToolCall(
  call: CodexToolCall,
  tools: ToolSet,
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
): Promise<ToolResultPart> {
  const tool = tools[call.name];
  if (!tool || typeof tool.execute !== "function") {
    return errorResult(call, `Tool "${call.name}" not found`);
  }

  const validation = await safeValidateTypes({
    value: call.arguments,
    schema: asSchema(tool.inputSchema),
  });
  if (!validation.success) {
    return errorResult(call, `Invalid arguments for tool "${call.name}": ${validation.error.message}`);
  }

  try {
    const result = await tool.execute(validation.value, {
      toolCallId: call.id,
      messages,
      abortSignal,
    });
    return {
      type: "tool-result",
      toolCallId: call.id,
      toolName: call.name,
      output: { type: "text", value: typeof result === "string" ? result : JSON.stringify(result) },
    };
  } catch (err) {
    return errorResult(call, err instanceof Error ? err.message : String(err));
  }
}

function errorResult(call: CodexToolCall, message: string): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: call.id,
    toolName: call.name,
    output: { type: "error-text", value: message },
  };
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

export async function codexGenerateText(
  opts: GenerateOpts & { modelId: string; profileName: string; stepLimit?: number },
): Promise<GenerateResult> {
  const { system, messages, prompt, tools, modelId, profileName, stepLimit, cacheKey, signal } = opts;

  const initialMessages: ModelMessage[] = prompt
    ? [{ role: "user", content: prompt }]
    : (messages ?? []);

  const limit = stepLimit ?? DEFAULT_STEP_LIMIT;

  // Fetch the token once per request. The step loop runs well within the
  // 5-minute refresh threshold, so a refresh mid-loop is not a concern.
  // Thread the per-call signal so a stalled token endpoint is bounded by the
  // same deadline as the request rather than hanging the turn.
  const accessToken = await getFreshToken(profileName, signal);

  const toToolCallPart = (tc: CodexToolCall) => ({
    type: "tool-call" as const,
    toolCallId: tc.id,
    toolName: tc.name,
    input: tc.arguments,
  });

  const convo: ModelMessage[] = [...initialMessages];
  let lastResult: CodexResponsesResult | undefined;
  let accumulated = emptyTokens();
  let stepCount = 0;

  for (let step = 0; step < limit; step++) {
    let result: CodexResponsesResult;
    try {
      result = await codexResponses({
        modelId,
        system,
        messages: convo,
        tools,
        accessToken,
        sessionId: cacheKey,
        signal,
      });
    } catch (err) {
      throw normalizeError(err);
    }

    if (result.stopReason === "error") {
      throw normalizeError(new Error(result.errorMessage ?? "Codex request failed"));
    }

    lastResult = result;
    accumulated = addTokens(accumulated, result.usage);
    stepCount++;

    const assistantContent: Array<
      | { type: "text"; text: string }
      | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
    > = [];
    if (result.text) assistantContent.push({ type: "text", text: result.text });
    assistantContent.push(...result.toolCalls.map(toToolCallPart));
    convo.push({ role: "assistant", content: assistantContent } as ModelMessage);

    const calls = result.toolCalls;
    if (calls.length === 0 || result.stopReason !== "toolUse") break;
    if (!tools) break;

    // Run tool calls in parallel to match AI SDK behavior; Promise.all preserves
    // order so the conversation stays aligned.
    const results = await Promise.all(
      calls.map((call) => executeToolCall(call, tools, initialMessages, signal)),
    );
    convo.push({ role: "tool", content: results } as ModelMessage);
  }

  if (!lastResult) {
    throw new Error("Codex completion returned no assistant message");
  }

  const toolCalls = lastResult.toolCalls.map(toToolCallPart);

  return {
    text: lastResult.text,
    toolCalls: toolCalls as GenerateResult["toolCalls"],
    finishReason: mapStopReason(lastResult.stopReason),
    usage: mapUsage(lastResult.usage),
    totalUsage: mapUsage(accumulated),
    steps: stepCount,
    cost: priceUsage("openai-codex", resolveCodexPriceId(modelId), accumulated),
  };
}
