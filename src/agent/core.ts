import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, ModelMessage } from "ai";
import { IntervalsClient } from "intervals-icu-api";
import type { Config } from "../config.js";
import { getHistoryLimit } from "../config.js";
import { Memory } from "./memory.js";
import { ChatStore } from "./chat-store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools.js";
import { withSessionLock } from "./session-lock.js";
import { limitHistoryTurns } from "./history-limit.js";
import {
  shouldCompact,
  isContextOverflowError,
  isTimeoutError,
  isRateLimitError,
  extractRetryAfterMs,
  estimateMessagesTokens,
  TIMEOUT_COMPACTION_THRESHOLD,
} from "./token-utils.js";
import { summarizeInStages } from "./compaction.js";
import { runMemoryFlush } from "./memory-flush.js";
import { evaluateSessionFreshness } from "./session-freshness.js";

const MAX_OVERFLOW_ATTEMPTS = 3;
const MAX_TIMEOUT_ATTEMPTS = 2;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_FALLBACK_BASE_MS = 5_000;
const RATE_LIMIT_FALLBACK_MULTIPLIER = 2;
const RATE_LIMIT_FALLBACK_MAX_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// AGENT
// ============================================================================

export class CyclingCoachAgent {
  private model: LanguageModel;
  private config: Config;
  private memory: Memory;
  private chatStore: ChatStore;
  private tools: ReturnType<typeof createTools>;
  private systemPrompt: string;

  constructor(config: Config) {
    this.config = config;
    this.model = createModel(config);
    this.memory = new Memory(config.dataDir);
    this.chatStore = new ChatStore(config.dataDir);

    const intervals = config.intervals.apiKey
      ? new IntervalsClient({
          apiKey: config.intervals.apiKey,
          athleteId: config.intervals.athleteId,
        })
      : null;

    this.tools = createTools(this.memory, intervals);
    this.systemPrompt = buildSystemPrompt(this.memory);
  }

  async chat(chatId: string, userMessage: string): Promise<string> {
    return withSessionLock(chatId, async () => {
      // Single file read: load history + last message time together
      let { messages: history, lastMessageTime } = this.chatStore.load(chatId);

      const { fresh } = evaluateSessionFreshness({
        lastMessageTime,
        dailyResetHour: this.config.session.dailyResetHour,
        idleMinutes: this.config.session.idleMinutes,
      });

      if (!fresh) {
        // Flush memory before reset, then archive
        if (history.length > 0) {
          await runMemoryFlush({ model: this.model, messages: history, memory: this.memory });
        }
        this.chatStore.archiveAndReset(chatId);
        history = [];
      }

      this.systemPrompt = buildSystemPrompt(this.memory);

      const limited = limitHistoryTurns(history, getHistoryLimit(this.config, chatId));

      // Build messages array with new user message
      let messages: ModelMessage[] = [...limited, { role: "user", content: userMessage }];

      let overflowAttempts = 0;
      let timeoutAttempts = 0;
      let rateLimitAttempts = 0;

      while (true) {
        // Preemptive: compact before sending if over budget
        if (shouldCompact({ messages, systemPrompt: this.systemPrompt, contextWindowTokens: this.config.contextWindowTokens })) {
          await runMemoryFlush({ model: this.model, messages, memory: this.memory });
          messages = await summarizeInStages({ messages, model: this.model });
          this.memory.reload();
        }

        try {
          const { text } = await generateText({
            model: this.model,
            system: this.systemPrompt,
            messages,
            tools: this.tools,
            stopWhen: stepCountIs(10),
          });

          // Append BOTH after success — JSONL unchanged on failure
          this.chatStore.appendMessage(chatId, "user", userMessage);
          this.chatStore.appendMessage(chatId, "assistant", text);

          return text;
        } catch (err) {
          // Reactive: context overflow → flush + compact + retry
          if (isContextOverflowError(err) && overflowAttempts < MAX_OVERFLOW_ATTEMPTS) {
            overflowAttempts++;
            await runMemoryFlush({ model: this.model, messages, memory: this.memory });
            messages = await summarizeInStages({ messages, model: this.model });
            this.memory.reload();
            continue;
          }
          // Timeout with high context usage → compact + retry (no flush)
          if (isTimeoutError(err) && timeoutAttempts < MAX_TIMEOUT_ATTEMPTS) {
            const ratio = estimateMessagesTokens(messages) / this.config.contextWindowTokens;
            if (ratio > TIMEOUT_COMPACTION_THRESHOLD) {
              timeoutAttempts++;
              messages = await summarizeInStages({ messages, model: this.model });
              this.memory.reload();
              continue;
            }
          }
          // Rate limit → backoff (respect retry-after) + retry
          if (isRateLimitError(err) && rateLimitAttempts < MAX_RATE_LIMIT_ATTEMPTS) {
            rateLimitAttempts++;
            const retryAfter = extractRetryAfterMs(err);
            const backoff = retryAfter
              ?? Math.min(
                   RATE_LIMIT_FALLBACK_BASE_MS * Math.pow(RATE_LIMIT_FALLBACK_MULTIPLIER, rateLimitAttempts - 1),
                   RATE_LIMIT_FALLBACK_MAX_MS,
                 );
            console.warn(`Rate limited (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_ATTEMPTS}), waiting ${backoff}ms`);
            await sleep(backoff);
            continue;
          }
          // Rate limit retries exhausted → compact before throwing so next message has smaller context
          if (isRateLimitError(err)) {
            await runMemoryFlush({ model: this.model, messages, memory: this.memory });
            messages = await summarizeInStages({ messages, model: this.model });
            this.chatStore.overwriteHistory(chatId, messages);
            throw err;
          }
          throw err;
        }
      }
    });
  }

  async resetSession(chatId: string): Promise<void> {
    // Memory flush before ANY reset — fixes OpenClaw bug #50891
    const history = this.chatStore.getHistory(chatId);
    if (history.length > 0) {
      await runMemoryFlush({ model: this.model, messages: history, memory: this.memory });
    }
    this.chatStore.archiveAndReset(chatId);
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
