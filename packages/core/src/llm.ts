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
}

export interface LLM {
  generate(opts: GenerateOpts): Promise<GenerateResult>;
}
