import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { IntervalsClient } from "intervals-icu-api";
import type { Config } from "../config.js";
import { Memory } from "./memory.js";
import { ChatStore } from "./chat-store.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools.js";
import { withSessionLock } from "./session-lock.js";
import { splitHistoryByBudget, makeSummaryMessage } from "./history-limit.js";
import {
  shouldCompact,
  computeHistoryTokenBudget,
  isContextOverflowError,
  isTimeoutError,
  isRateLimitError,
  extractRetryAfterMs,
  estimateMessagesTokens,
  TIMEOUT_COMPACTION_THRESHOLD,
} from "./token-utils.js";
import { summarizeInStages, summarizeDroppedMessages } from "./compaction.js";
import { runMemoryFlush } from "./memory-flush.js";
import { evaluateSessionFreshness } from "./session-freshness.js";
import { LLM } from "./llm.js";
import { createMemorySnapshot } from "./memory-snapshot.js";
import { cyclingSport } from "../cycling/sport.js";

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
  private llm: LLM;
  private config: Config;
  private memory: Memory;
  private chatStore: ChatStore;
  private tools: ReturnType<typeof createTools>;
  private systemPrompt: string;

  constructor(config: Config) {
    this.config = config;
    this.llm = new LLM(config);
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
          await runMemoryFlush({
            llm: this.llm,
            messages: history,
            memory: this.memory,
            memorySections: cyclingSport.memorySections,
          });
        }
        this.chatStore.archiveAndReset(chatId);
        history = [];
      }

      this.systemPrompt = buildSystemPrompt(this.memory);

      const budget = computeHistoryTokenBudget({
        contextWindowTokens: this.config.contextWindowTokens,
        systemPrompt: this.systemPrompt,
        budgetRatio: this.config.session.historyTokenBudgetRatio,
      });
      const { kept, dropped, previousSummary } = splitHistoryByBudget({
        messages: history,
        tokenBudget: budget,
      });

      let summaryMsg: ModelMessage | undefined;
      if (dropped.length > 0) {
        try {
          const summary = await summarizeDroppedMessages({
            dropped,
            llm: this.llm,
            mustPreserveTokens: cyclingSport.mustPreserveTokens,
            memory: createMemorySnapshot(this.memory),
            previousSummary,
            contextWindowTokens: this.config.contextWindowTokens,
          });
          summaryMsg = makeSummaryMessage(summary);
          this.chatStore.overwriteHistory(chatId, [summaryMsg, ...kept]);
        } catch (err) {
          console.warn("Dropped message summarization failed, continuing without summary", err);
          if (previousSummary) {
            summaryMsg = makeSummaryMessage(previousSummary);
          }
        }
      } else if (previousSummary) {
        summaryMsg = makeSummaryMessage(previousSummary);
      }

      // Build messages array with new user message
      let messages: ModelMessage[] = [
        ...(summaryMsg ? [summaryMsg] : []),
        ...kept,
        { role: "user", content: userMessage },
      ];

      let overflowAttempts = 0;
      let timeoutAttempts = 0;
      let rateLimitAttempts = 0;

      while (true) {
        // Preemptive: compact before sending if over budget
        if (shouldCompact({ messages, systemPrompt: this.systemPrompt, contextWindowTokens: this.config.contextWindowTokens })) {
          await runMemoryFlush({
            llm: this.llm,
            messages,
            memory: this.memory,
            memorySections: cyclingSport.memorySections,
          });
          messages = await summarizeInStages({
            messages,
            llm: this.llm,
            mustPreserveTokens: cyclingSport.mustPreserveTokens,
            memory: createMemorySnapshot(this.memory),
            contextWindowTokens: this.config.contextWindowTokens,
          });
          this.memory.reload();
        }

        try {
          const { text } = await this.llm.generate({
            system: this.systemPrompt,
            messages,
            tools: this.tools,
            stopWhen: stepCountIs(10),
            maxSteps: 10,
          });

          // Append BOTH after success — JSONL unchanged on failure
          this.chatStore.appendMessage(chatId, "user", userMessage);
          this.chatStore.appendMessage(chatId, "assistant", text);

          return text;
        } catch (err) {
          // Reactive: context overflow → flush + compact + retry
          if (isContextOverflowError(err) && overflowAttempts < MAX_OVERFLOW_ATTEMPTS) {
            overflowAttempts++;
            await runMemoryFlush({
              llm: this.llm,
              messages,
              memory: this.memory,
              memorySections: cyclingSport.memorySections,
            });
            messages = await summarizeInStages({
              messages,
              llm: this.llm,
              mustPreserveTokens: cyclingSport.mustPreserveTokens,
              memory: createMemorySnapshot(this.memory),
              contextWindowTokens: this.config.contextWindowTokens,
            });
            this.memory.reload();
            continue;
          }
          // Timeout with high context usage → compact + retry (no flush)
          if (isTimeoutError(err) && timeoutAttempts < MAX_TIMEOUT_ATTEMPTS) {
            const ratio = estimateMessagesTokens(messages) / this.config.contextWindowTokens;
            if (ratio > TIMEOUT_COMPACTION_THRESHOLD) {
              timeoutAttempts++;
              messages = await summarizeInStages({
                messages,
                llm: this.llm,
                mustPreserveTokens: cyclingSport.mustPreserveTokens,
                memory: createMemorySnapshot(this.memory),
                contextWindowTokens: this.config.contextWindowTokens,
              });
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
          // Rate limit retries exhausted → throw to caller (skip compaction — API is rate limited)
          throw err;
        }
      }
    });
  }

  async resetSession(chatId: string): Promise<void> {
    // Flush before reset to avoid losing un-persisted context
    const { messages: history } = this.chatStore.load(chatId);
    if (history.length > 0) {
      await runMemoryFlush({
            llm: this.llm,
            messages: history,
            memory: this.memory,
            memorySections: cyclingSport.memorySections,
          });
    }
    this.chatStore.archiveAndReset(chatId);
  }

  getMemory(): Memory {
    return this.memory;
  }
}
