import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { IntervalsClient } from "intervals-icu-api";
import type { Config } from "../config.js";
import { Memory } from "./memory.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools.js";

// ============================================================================
// AGENT
// ============================================================================

export class CyclingCoachAgent {
  private model: LanguageModel;
  private memory: Memory;
  private tools: ReturnType<typeof createTools>;
  private systemPrompt: string;

  constructor(config: Config) {
    this.model = createModel(config);
    this.memory = new Memory(config.dataDir);

    const intervals = config.intervals.apiKey
      ? new IntervalsClient({
          apiKey: config.intervals.apiKey,
          athleteId: config.intervals.athleteId,
        })
      : null;

    this.tools = createTools(this.memory, intervals);
    this.systemPrompt = buildSystemPrompt(this.memory);
  }

  async chat(userMessage: string): Promise<string> {
    this.systemPrompt = buildSystemPrompt(this.memory);

    const { text } = await generateText({
      model: this.model,
      system: this.systemPrompt,
      prompt: userMessage,
      tools: this.tools,
      stopWhen: stepCountIs(10),
    });

    return text;
  }

  getMemory(): Memory {
    return this.memory;
  }
}

// ============================================================================
// MODEL FACTORY
// ============================================================================

function createModel(config: Config): LanguageModel {
  switch (config.llm.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.llm.apiKey });
      return anthropic(config.llm.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: config.llm.apiKey });
      return openai(config.llm.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.llm.apiKey });
      return google(config.llm.model);
    }
  }
}
