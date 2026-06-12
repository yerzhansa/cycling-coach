import type { ModelMessage } from "ai";
import type { LLM } from "../../src/llm.js";
import type { GenerateOpts, GenerateResult } from "../../src/llm-types.js";

export interface FakeTurn {
  text?: string;
  toolCalls?: GenerateResult["toolCalls"];
  finishReason?: GenerateResult["finishReason"];
  usage?: Partial<GenerateResult["usage"]>;
  error?: Error;
}

export type QueuedTurn = string | FakeTurn;

export interface FakeLLMOptions {
  /** Replay the final queued turn forever once the queue is exhausted. */
  repeatLast?: boolean;
}

export interface FakeLLM extends LLM {
  capturedPrompts: string[];
  capturedMessages: ModelMessage[][];
  capturedOpts: GenerateOpts[];
}

function zeroUsage(): GenerateResult["usage"] {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  };
}

/**
 * Queue-backed in-process LLM fake. Each generate() call consumes the next
 * queued turn (string shorthand = text-only turn); an exhausted queue serves
 * an empty no-tool-call turn unless repeatLast is set. Turns may script
 * toolCalls / finishReason / usage per call, or reject via `error`. Every
 * call is recorded in capturedOpts; prompt/messages calls additionally land
 * in capturedPrompts/capturedMessages. The fake never executes opts.tools.
 */
export function createFakeLLM(
  turns: QueuedTurn[] = [],
  options: FakeLLMOptions = {},
): FakeLLM {
  const capturedPrompts: string[] = [];
  const capturedMessages: ModelMessage[][] = [];
  const capturedOpts: GenerateOpts[] = [];
  let next = 0;
  const fake = {
    capturedPrompts,
    capturedMessages,
    capturedOpts,
    async generate(opts: GenerateOpts): Promise<GenerateResult> {
      capturedOpts.push(opts);
      if (opts.prompt !== undefined) capturedPrompts.push(opts.prompt);
      if (opts.messages !== undefined) capturedMessages.push(opts.messages);
      const queued =
        next < turns.length
          ? turns[next++]
          : options.repeatLast && turns.length > 0
            ? turns[turns.length - 1]
            : {};
      const turn: FakeTurn = typeof queued === "string" ? { text: queued } : queued;
      if (turn.error) throw turn.error;
      return {
        text: turn.text ?? "",
        toolCalls: turn.toolCalls ?? [],
        finishReason: turn.finishReason ?? "stop",
        usage: { ...zeroUsage(), ...turn.usage },
      };
    },
  };
  return fake as unknown as FakeLLM;
}
