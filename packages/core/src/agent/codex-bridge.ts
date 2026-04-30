import { asSchema } from "@ai-sdk/provider-utils";
import { complete, getModel } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message as PiMessage,
  StopReason,
  TextContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
  ToolResultMessage,
  Usage as PiUsage,
} from "@mariozechner/pi-ai";
import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  ToolSet,
} from "ai";

import { getFreshToken } from "../auth/profiles.js";
import type { GenerateOpts, GenerateResult } from "../llm-types.js";

const DEFAULT_STEP_LIMIT = 10;

// Pi-ai's codex provider retries 429/5xx internally and ignores maxRetryDelayMs;
// our outer loop in core.ts owns backoff. Throwing an Error whose message
// contains PI_AI_NO_RETRY_MARKER triggers pi-ai's no-retry escape
// (openai-codex-responses.js: the retry loop skips when the message matches).
// Do not rephrase the marker without verifying pi-ai still honors it.
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const PI_AI_NO_RETRY_MARKER = "usage limit";

const onCodexResponse = async ({ status }: { status: number }): Promise<void> => {
  if (RETRYABLE_HTTP_STATUSES.has(status)) {
    throw new Error(`${PI_AI_NO_RETRY_MARKER} blocked client retry (status=${status})`);
  }
};

// ============================================================================
// ERROR NORMALIZATION
// ============================================================================

/**
 * Pi-ai throws plain Error instances with human messages. Our retry loop in
 * core.ts relies on token-utils predicates that look for specific substrings.
 * Rewrite the message so those predicates trigger correctly without having to
 * teach them about pi-ai's error surface.
 */
function normalizeError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const msg = err.message ?? "";
  const lower = msg.toLowerCase();

  if (/usage.?limit|rate.?limit|too many requests|429/i.test(msg)) {
    const out = new Error(`Rate limit exceeded: ${msg}`);
    out.name = "RateLimitError";
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
// MESSAGE CONVERSION: AI SDK ModelMessage[] → pi-ai Context
// ============================================================================

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") return p.text;
      }
      return "";
    })
    .join("");
}

function convertMessages(messages: ModelMessage[]): PiMessage[] {
  const out: PiMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // System is carried separately on Context; ignore here.
      continue;
    }

    if (m.role === "user") {
      out.push({
        role: "user",
        content: extractText(m.content),
        timestamp: Date.now(),
      });
      continue;
    }

    if (m.role === "assistant") {
      const parts: (TextContent | PiToolCall)[] = [];
      if (typeof m.content === "string") {
        if (m.content) parts.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text" && p.text) {
            parts.push({ type: "text", text: p.text });
          } else if (p.type === "tool-call") {
            parts.push({
              type: "toolCall",
              id: p.toolCallId,
              name: p.toolName,
              arguments: (p.input ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
      out.push({
        role: "assistant",
        content: parts,
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "",
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
      continue;
    }

    if (m.role === "tool") {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content) {
        if (p.type !== "tool-result") continue;
        out.push({
          role: "toolResult",
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          content: [{ type: "text", text: stringifyToolOutput(p.output) }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
  }

  return out;
}

function stringifyToolOutput(output: unknown): string {
  if (output && typeof output === "object" && "type" in output) {
    const o = output as { type: string; value?: unknown };
    if (o.type === "text" && typeof o.value === "string") return o.value;
    if (o.type === "error-text" && typeof o.value === "string") return o.value;
    if (o.type === "json") return JSON.stringify(o.value);
    if (o.type === "error-json") return JSON.stringify(o.value);
  }
  return typeof output === "string" ? output : JSON.stringify(output);
}

function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ============================================================================
// TOOL CONVERSION: AI SDK ToolSet → pi-ai Tool[]
// ============================================================================

async function convertTools(tools: ToolSet | undefined): Promise<PiTool[]> {
  if (!tools) return [];
  const out: PiTool[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const schema = asSchema(t.inputSchema);
    const json = await Promise.resolve(schema.jsonSchema);
    out.push({
      name,
      description: t.description ?? "",
      parameters: json as PiTool["parameters"],
    });
  }
  return out;
}

// ============================================================================
// RESULT CONVERSION: pi-ai AssistantMessage → AI SDK GenerateResult
// ============================================================================

function mapStopReason(reason: StopReason): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "toolUse":
      return "tool-calls";
    case "aborted":
      return "other";
    case "error":
      return "error";
    default:
      return "other";
  }
}

function mapUsage(u: PiUsage): LanguageModelUsage {
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

function collectText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function collectToolCalls(msg: AssistantMessage): PiToolCall[] {
  return msg.content.filter((b): b is PiToolCall => b.type === "toolCall");
}

// ============================================================================
// TOOL EXECUTION
// ============================================================================

async function executeToolCall(
  call: PiToolCall,
  tools: ToolSet,
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
): Promise<ToolResultMessage> {
  const tool = tools[call.name];
  if (!tool || typeof tool.execute !== "function") {
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: `Tool "${call.name}" not found` }],
      isError: true,
      timestamp: Date.now(),
    };
  }

  try {
    const result = await tool.execute(call.arguments, {
      toolCallId: call.id,
      messages,
      abortSignal,
    });
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now(),
    };
  } catch (err) {
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
      timestamp: Date.now(),
    };
  }
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

export async function codexGenerateText(
  opts: GenerateOpts & { modelId: string; profileName: string; stepLimit?: number },
): Promise<GenerateResult> {
  const { system, messages, prompt, tools, modelId, profileName, maxOutputTokens, stepLimit } = opts;

  const initialMessages: ModelMessage[] = prompt
    ? [{ role: "user", content: prompt }]
    : (messages ?? []);

  const piTools = await convertTools(tools);

  const model = getModelOrThrow(modelId);
  const limit = stepLimit ?? DEFAULT_STEP_LIMIT;

  const piMessages: PiMessage[] = convertMessages(initialMessages);

  // Fetch the token once per request. The step loop runs well within the
  // 5-minute refresh threshold and pi-ai's internal retries are already
  // short-circuited, so a refresh during the loop is not a concern.
  const apiKey = await getFreshToken(profileName);

  let lastAssistant: AssistantMessage | undefined;

  for (let step = 0; step < limit; step++) {
    const context: Context = {
      systemPrompt: system,
      messages: piMessages,
      tools: piTools,
    };

    let assistant: AssistantMessage;
    try {
      assistant = await complete(model, context, {
        apiKey,
        maxTokens: maxOutputTokens,
        onResponse: onCodexResponse,
      });
    } catch (err) {
      throw normalizeError(err);
    }

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw normalizeError(new Error(assistant.errorMessage ?? "Codex request failed"));
    }

    lastAssistant = assistant;
    piMessages.push(assistant);

    const calls = collectToolCalls(assistant);
    if (calls.length === 0 || assistant.stopReason !== "toolUse") {
      break;
    }

    if (!tools) break;

    // Run tool calls in parallel to match AI SDK behavior; Promise.all
    // preserves result order so the pi-ai context stays aligned.
    const results = await Promise.all(
      calls.map((call) => executeToolCall(call, tools, initialMessages)),
    );
    for (const result of results) piMessages.push(result);
  }

  if (!lastAssistant) {
    throw new Error("Codex completion returned no assistant message");
  }

  const toolCalls = collectToolCalls(lastAssistant).map((c) => ({
    type: "tool-call" as const,
    toolCallId: c.id,
    toolName: c.name,
    input: c.arguments,
  }));

  return {
    text: collectText(lastAssistant),
    toolCalls: toolCalls as GenerateResult["toolCalls"],
    finishReason: mapStopReason(lastAssistant.stopReason),
    usage: mapUsage(lastAssistant.usage),
  };
}

// ============================================================================
// MODEL RESOLUTION
// ============================================================================

function getModelOrThrow(modelId: string) {
  // Fall back to gpt-5.4 template for IDs not in pi-ai's catalog (e.g. pro).
  try {
    return getModel("openai-codex", modelId as "gpt-5.4");
  } catch {
    const fallback = getModel("openai-codex", "gpt-5.4");
    return { ...fallback, id: modelId, name: modelId };
  }
}

