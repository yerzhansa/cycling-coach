import { asSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  SDKMessage,
  SDKResultMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { FinishReason, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { z } from "zod";

import type { GenerateOpts, GenerateResult } from "../../llm-types.js";
import type { ModelStreamActivity } from "../../sport.js";
import type { ClaudeCliBilling, ClaudeCliRuntime } from "./env.js";
import { binaryMissingError, normalizeClaudeCliError } from "./errors.js";
import { resolveClaudeBinary } from "./executable.js";
import { buildQueryOptions, startGeneration, type SanitizedQueryOptions } from "./session.js";

export const CLAUDE_CLI_MCP_SERVER_NAME = "coach";
export const CLAUDE_CLI_TOOL_PREFIX = `mcp__${CLAUDE_CLI_MCP_SERVER_NAME}__`;

const DEFAULT_STEP_LIMIT = 10;
const INTER_FRAME_STALL_MS = 120_000;
const TRANSCRIPT_OPEN = "<conversation-transcript>";
const TRANSCRIPT_CLOSE = "</conversation-transcript>";

const TERMINAL_REASON_PHRASES: Record<string, string> = {
  prompt_too_long: "prompt is too long",
  blocking_limit: "usage limit reached",
  rapid_refill_breaker: "rate limit",
  aborted_streaming: "request was aborted",
  aborted_tools: "request was aborted",
  api_error: "error_during_execution",
  model_error: "error_during_execution",
  turn_setup_failed: "error_during_execution",
};

export interface ClaudeCliBridgeRuntime {
  readonly binaryPath?: string;
  readonly configDir?: string;
  readonly billing: ClaudeCliBilling;
}

export interface ClaudeCliBridgePorts {
  readonly runtime: ClaudeCliBridgeRuntime;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly query?: typeof sdkQuery;
  readonly resolveBinary?: (explicitPath?: string) => Promise<string | null>;
  readonly stallMs?: number;
}

export type ClaudeCliGenerateOpts = GenerateOpts & {
  modelId: string;
  stepLimit?: number;
};

export interface CoachToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CoachToolResult>;
}

export interface CoachToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CoachToolContext {
  readonly messages: ModelMessage[];
  readonly signal?: AbortSignal;
  readonly context?: unknown;
}

function passthroughSchema(): Record<string, unknown> {
  return z.looseObject({}) as unknown as Record<string, unknown>;
}

function toolInputSchema(tool: ToolSet[string]): Record<string, unknown> {
  try {
    const jsonSchema = asSchema(tool.inputSchema).jsonSchema;
    const converted = z.fromJSONSchema(jsonSchema as never, { defaultTarget: "draft-7" });
    const shape = (converted as { shape?: Record<string, unknown> }).shape;
    if (shape !== undefined && Object.keys(shape).length > 0) return shape;
  } catch {
    return passthroughSchema();
  }
  return passthroughSchema();
}

function textResult(text: string, isError?: boolean): CoachToolResult {
  return isError === true
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export function buildCoachToolDefinitions(
  tools: ToolSet,
  ctx: CoachToolContext,
): CoachToolDefinition[] {
  let callCounter = 0;
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? name,
    inputSchema: toolInputSchema(tool),
    handler: async (args: Record<string, unknown>): Promise<CoachToolResult> => {
      callCounter += 1;
      const toolCallId = `claude-cli-${callCounter}`;
      if (typeof tool.execute !== "function") {
        return textResult(`Tool "${name}" is not executable`, true);
      }
      const validation = await safeValidateTypes({
        value: args,
        schema: asSchema(tool.inputSchema),
      });
      if (!validation.success) {
        return textResult(
          `Invalid arguments for tool "${name}": ${validation.error.message}`,
          true,
        );
      }
      try {
        const result = await tool.execute(validation.value, {
          toolCallId,
          messages: ctx.messages,
          abortSignal: ctx.signal,
          experimental_context: ctx.context,
        });
        return textResult(typeof result === "string" ? result : JSON.stringify(result));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  }));
}

export interface CoachToolSurface {
  readonly server: McpSdkServerConfigWithInstance;
  readonly toolNames: string[];
}

export function buildCoachToolSurface(tools: ToolSet, ctx: CoachToolContext): CoachToolSurface {
  const definitions = buildCoachToolDefinitions(tools, ctx);
  const server = createSdkMcpServer({
    name: CLAUDE_CLI_MCP_SERVER_NAME,
    tools: definitions as never,
  });
  return {
    server,
    toolNames: definitions.map((definition) => `${CLAUDE_CLI_TOOL_PREFIX}${definition.name}`),
  };
}

export function buildCanUseTool(allowed: readonly string[]): CanUseTool {
  const permitted = new Set(allowed);
  return async (toolName, input) =>
    permitted.has(toolName)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `${toolName} is not permitted` };
}

function messageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "tool-call") {
      parts.push(`[tool-call ${part.toolName} ${JSON.stringify(part.input)}]`);
    } else if (part.type === "tool-result") {
      parts.push(`[tool-result ${part.toolName} ${JSON.stringify(part.output)}]`);
    }
  }
  return parts.join("\n");
}

export function renderPrompt(opts: Pick<GenerateOpts, "prompt" | "messages">): string {
  if (opts.prompt !== undefined) return opts.prompt;
  const messages = opts.messages ?? [];
  if (messages.length === 0) return "";
  let liveIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      liveIndex = i;
      break;
    }
  }
  const history = liveIndex < 0 ? messages : messages.slice(0, liveIndex);
  const live = liveIndex < 0 ? "" : messageText(messages[liveIndex]);
  if (history.length === 0) return live;
  const transcript = history
    .map((message) => `${message.role}: ${messageText(message)}`)
    .join("\n\n");
  return `${TRANSCRIPT_OPEN}\n${transcript}\n${TRANSCRIPT_CLOSE}\n\n${live}`;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function validCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return validToken(value) ? value : 0;
}

export function tokenTotalsFromResult(result: SDKResultMessage): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const modelUsage = (result as { modelUsage?: unknown }).modelUsage;
  if (modelUsage !== null && typeof modelUsage === "object") {
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      totals.input += readNumber(record, "inputTokens");
      totals.output += readNumber(record, "outputTokens");
      totals.cacheRead += readNumber(record, "cacheReadInputTokens");
      totals.cacheWrite += readNumber(record, "cacheCreationInputTokens");
    }
  }
  if (totals.input > 0 || totals.output > 0 || totals.cacheRead > 0 || totals.cacheWrite > 0) {
    return totals;
  }
  const usage = (result as { usage?: unknown }).usage;
  if (usage !== null && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    totals.input = readNumber(record, "input_tokens");
    totals.output = readNumber(record, "output_tokens");
    totals.cacheRead = readNumber(record, "cache_read_input_tokens");
    totals.cacheWrite = readNumber(record, "cache_creation_input_tokens");
  }
  return totals;
}

export function mapUsage(totals: TokenTotals): LanguageModelUsage {
  return {
    inputTokens: safeTokenSum(totals.input, totals.cacheRead, totals.cacheWrite),
    outputTokens: validToken(totals.output) ? totals.output : undefined,
    totalTokens: safeTokenSum(totals.input, totals.cacheRead, totals.cacheWrite, totals.output),
    reasoningTokens: undefined,
    cachedInputTokens: validToken(totals.cacheRead) ? totals.cacheRead : undefined,
    inputTokenDetails: {
      noCacheTokens: validToken(totals.input) ? totals.input : undefined,
      cacheReadTokens: validToken(totals.cacheRead) ? totals.cacheRead : undefined,
      cacheWriteTokens: validToken(totals.cacheWrite) ? totals.cacheWrite : undefined,
    },
    outputTokenDetails: {
      reasoningTokens: undefined,
      acceptedPredictionTokens: undefined,
      rejectedPredictionTokens: undefined,
    },
  } as unknown as LanguageModelUsage;
}

export function mapFinishReason(result: SDKResultMessage): FinishReason {
  if (result.subtype === "error_max_turns") return "tool-calls";
  switch (result.stop_reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "end_turn":
    case "stop_sequence":
    case null:
    case undefined:
      return "stop";
    default:
      return "other";
  }
}

function resultErrorMessage(result: SDKResultMessage): string {
  const parts: string[] = [];
  const errors = (result as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) if (typeof entry === "string") parts.push(entry);
  }
  const text = (result as { result?: unknown }).result;
  if (typeof text === "string" && text.trim() !== "") parts.push(text);
  const reason = result.terminal_reason;
  if (typeof reason === "string") {
    const phrase = TERMINAL_REASON_PHRASES[reason];
    parts.push(phrase ?? `terminal_reason=${reason}`);
  }
  return parts.length === 0 ? "Claude Code CLI returned an error result" : parts.join(" | ");
}

interface FrameCollector {
  text: string;
  toolCalls: GenerateResult["toolCalls"];
  retryAfterMs?: number;
  streamed: boolean;
}

function retryAfterFromRateLimit(frame: SDKMessage): number | undefined {
  const info = (frame as { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
  if (info === undefined) return undefined;
  if (info.status !== "rejected") return undefined;
  const resetsAt = info.resetsAt;
  if (!validToken(resetsAt)) return undefined;
  const remainingMs = resetsAt * 1000 - Date.now();
  return remainingMs > 0 ? remainingMs : undefined;
}

function collectFrame(
  frame: SDKMessage,
  collector: FrameCollector,
  onTextDelta: ((delta: string) => void) | undefined,
  onStreamActivity: ((activity: ModelStreamActivity) => void) | undefined,
): void {
  if (frame.type === "stream_event") {
    const event = (frame as unknown as { event?: Record<string, unknown> }).event;
    const delta = event?.delta as { type?: string; text?: string } | undefined;
    if (event?.type === "content_block_delta" && delta?.type === "text_delta") {
      const text = delta.text ?? "";
      if (text !== "") {
        collector.streamed = true;
        notify(onTextDelta, text);
      }
    }
    return;
  }

  if (frame.type === "assistant") {
    const content = (frame as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    const toolCalls: GenerateResult["toolCalls"] = [];
    let text = "";
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "";
        toolCalls.push({
          type: "tool-call",
          toolCallId: block.id,
          toolName: name.startsWith(CLAUDE_CLI_TOOL_PREFIX)
            ? name.slice(CLAUDE_CLI_TOOL_PREFIX.length)
            : name,
          input: block.input,
        });
        notifyActivity(onStreamActivity, { type: "tool_start", toolCallId: block.id });
      }
    }
    collector.text = text;
    collector.toolCalls = toolCalls;
    if (!collector.streamed && text !== "") notify(onTextDelta, text);
    return;
  }

  if (frame.type === "user") {
    const content = (frame as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        notifyActivity(onStreamActivity, { type: "tool_end", toolCallId: block.tool_use_id });
      }
    }
    return;
  }

  if (frame.type === "rate_limit_event") {
    const retryAfterMs = retryAfterFromRateLimit(frame);
    if (retryAfterMs !== undefined) collector.retryAfterMs = retryAfterMs;
  }
}

function notify(observer: ((delta: string) => void) | undefined, delta: string): void {
  try {
    observer?.(delta);
  } catch {}
}

function notifyActivity(
  observer: ((activity: ModelStreamActivity) => void) | undefined,
  activity: ModelStreamActivity,
): void {
  try {
    observer?.(activity);
  } catch {}
}

function stalledError(stallMs: number): Error {
  const out = new Error(`Claude Code CLI stalled for ${stallMs}ms without a frame`);
  out.name = "TimeoutError";
  return out;
}

async function nextFrame(
  iterator: AsyncIterator<SDKMessage>,
  stallMs: number,
): Promise<IteratorResult<SDKMessage>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(stalledError(stallMs)), stallMs);
  });
  try {
    return await Promise.race([iterator.next(), stall]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function linkAbort(signal: AbortSignal | undefined): {
  controller: AbortController;
  release: () => void;
} {
  const controller = new AbortController();
  if (signal === undefined) return { controller, release: () => undefined };
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, release: () => undefined };
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return { controller, release: () => signal.removeEventListener("abort", onAbort) };
}

async function resolveRuntime(ports: ClaudeCliBridgePorts): Promise<ClaudeCliRuntime> {
  const explicit = ports.runtime.binaryPath;
  if (explicit !== undefined && explicit !== "") {
    return {
      binaryPath: explicit,
      configDir: ports.runtime.configDir,
      billing: ports.runtime.billing,
    };
  }
  const resolve =
    ports.resolveBinary ?? ((path?: string) => resolveClaudeBinary({ explicitPath: path }));
  const resolved = await resolve(explicit);
  if (resolved === null || resolved === "") throw binaryMissingError("claude");
  return {
    binaryPath: resolved,
    configDir: ports.runtime.configDir,
    billing: ports.runtime.billing,
  };
}

export function buildGenerationOptions(
  opts: ClaudeCliGenerateOpts,
  runtime: ClaudeCliRuntime,
  baseEnv: NodeJS.ProcessEnv,
  surface: CoachToolSurface | null,
  abortController: AbortController,
): SanitizedQueryOptions {
  const toolNames = surface === null ? [] : surface.toolNames;
  return buildQueryOptions({
    runtime,
    baseEnv,
    model: opts.modelId,
    systemPrompt: opts.system,
    mcpServers: surface === null ? {} : { [CLAUDE_CLI_MCP_SERVER_NAME]: surface.server },
    tools: toolNames,
    allowedTools: toolNames,
    canUseTool: buildCanUseTool(toolNames),
    maxTurns: opts.stepLimit ?? DEFAULT_STEP_LIMIT,
    includePartialMessages: true,
    abortController,
  });
}

async function runGeneration(
  opts: ClaudeCliGenerateOpts,
  ports: ClaudeCliBridgePorts,
  runtime: ClaudeCliRuntime,
): Promise<GenerateResult> {
  const baseEnv = ports.baseEnv ?? process.env;
  const stallMs = ports.stallMs ?? INTER_FRAME_STALL_MS;
  const initialMessages: ModelMessage[] = opts.prompt
    ? [{ role: "user", content: opts.prompt }]
    : (opts.messages ?? []);
  const surface =
    opts.tools === undefined || Object.keys(opts.tools).length === 0
      ? null
      : buildCoachToolSurface(opts.tools, {
          messages: initialMessages,
          signal: opts.signal,
          context: opts.context,
        });

  const { controller, release } = linkAbort(opts.signal);
  const options = buildGenerationOptions(opts, runtime, baseEnv, surface, controller);
  const generation = startGeneration(
    { prompt: renderPrompt(opts), options },
    { query: ports.query },
  );

  const collector: FrameCollector = { text: "", toolCalls: [], streamed: false };
  try {
    const iterator = generation.frames()[Symbol.asyncIterator]();
    for (;;) {
      const step = await nextFrame(iterator, stallMs);
      if (step.done === true) break;
      collectFrame(step.value, collector, opts.onTextDelta, opts.onStreamActivity);
    }
  } catch (err) {
    if (generation.lastResult() === null) {
      const normalized = normalizeClaudeCliError(err, { retryAfterMs: collector.retryAfterMs });
      const carrier = normalized as Error & { retryAfterMs?: number };
      if (carrier.retryAfterMs === undefined && collector.retryAfterMs !== undefined) {
        carrier.retryAfterMs = collector.retryAfterMs;
      }
      throw normalized;
    }
  } finally {
    release();
    await generation.close();
  }

  const result = generation.lastResult();
  if (result === null) {
    throw normalizeClaudeCliError(new Error("Claude Code CLI ended without a result frame"), {
      retryAfterMs: collector.retryAfterMs,
    });
  }

  if (result.is_error === true && result.subtype !== "error_max_turns") {
    const failure = new Error(resultErrorMessage(result)) as Error & { httpStatus?: number };
    const status = (result as { api_error_status?: unknown }).api_error_status;
    if (validToken(status)) failure.httpStatus = status;
    throw normalizeClaudeCliError(failure, { retryAfterMs: collector.retryAfterMs });
  }

  const text = result.subtype === "success" ? result.result : collector.text;
  const usage = mapUsage(tokenTotalsFromResult(result));
  return {
    text,
    toolCalls: collector.toolCalls,
    finishReason: mapFinishReason(result),
    usage,
    totalUsage: usage,
    steps: validToken(result.num_turns) ? result.num_turns : undefined,
    providerReportedCostUsd:
      runtime.billing === "api-key" && validCost(result.total_cost_usd)
        ? result.total_cost_usd
        : undefined,
  };
}

function isSubprocessDeath(err: unknown): boolean {
  return err instanceof Error && err.name === "NetworkError";
}

export async function claudeCliGenerateText(
  opts: ClaudeCliGenerateOpts,
  ports: ClaudeCliBridgePorts,
): Promise<GenerateResult> {
  const runtime = await resolveRuntime(ports);
  try {
    return await runGeneration(opts, ports, runtime);
  } catch (err) {
    if (!isSubprocessDeath(err) || opts.signal?.aborted === true) throw err;
    return await runGeneration(opts, ports, runtime);
  }
}
