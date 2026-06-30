import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  StopCondition,
  ToolSet,
} from "ai";

export interface GenerateOpts {
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  tools?: ToolSet;
  stopWhen?: StopCondition<any> | Array<StopCondition<any>>;
  maxSteps?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Upper bound (ms) on this single call, intersected with the caller's per-call deadline. Lets the agent loop cap a call by the turn's remaining wall-clock budget so a retry after an early timeout cannot open a fresh full deadline window. */
  deadlineMs?: number;
  /** Codex-only: forwarded to the codex bridge as its session id. The AI-SDK providers never read it. */
  cacheKey?: string;
  caller?: "chat" | "flush" | "compact";
}

export interface GenerateResult {
  text: string;
  toolCalls: Array<{
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;
  steps?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
