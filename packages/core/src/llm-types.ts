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
