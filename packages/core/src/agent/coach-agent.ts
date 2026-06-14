import { createHash } from "node:crypto";
import { stepCountIs } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { makeChatClient } from "../reference/sync/intervals-client-factory.js";
import { getEffectiveSections } from "../memory/effective-sections.js";
import type { CoreDeps, Sport } from "../sport.js";
import type { SecretsResolver } from "../secrets/types.js";
import type { Config } from "../config.js";
import { resolveSecretRef } from "../secrets/resolve.js";
import { Memory } from "../memory/store.js";
import { ChatStore } from "./chat-store.js";
import { buildSystemPrompt, staticRuleBlocks } from "./system-prompt.js";
import { computePromptLineage } from "./prompt-lineage.js";
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
import { runMemoryFlush, FLUSH_ZERO_WRITE_MIN_MESSAGES, shouldRunMemoryFlush } from "./memory-flush.js";
import type { MemoryFlushOutcome } from "./memory-flush.js";
import { evaluateSessionFreshness } from "./session-freshness.js";
import { LLM } from "../llm.js";
import { appendUsageLine } from "../usage-ledger.js";
import { createMemorySnapshot } from "../memory/snapshot.js";
import { resolveUserTimezone, appendCurrentTimeLine } from "./user-time.js";

const MAX_OVERFLOW_ATTEMPTS = 3;
const MAX_TIMEOUT_ATTEMPTS = 2;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_FALLBACK_BASE_MS = 5_000;
const RATE_LIMIT_FALLBACK_MULTIPLIER = 2;
const RATE_LIMIT_FALLBACK_MAX_MS = 30_000;
const RATE_LIMIT_MAX_WAIT_MS = 120_000;
const MAX_FLUSH_ATTEMPTS = 2;

type MemoryFlushTrigger =
  | "stale-reset"
  | "explicit-reset"
  | "trim"
  | "pre-compaction"
  | "overflow-recovery"
  | "soft-threshold";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKeyForChat(chatId: string): string {
  return createHash("sha256").update(chatId).digest("hex").slice(0, 16);
}

// ============================================================================
// AGENT
// ============================================================================

export class CoachAgent {
  private sport: Sport;
  private llm: LLM;
  private flushLlm: LLM;
  private config: Config;
  private memory: Memory;
  private chatStore: ChatStore;
  private tools: ToolSet;
  private systemPrompt: string;
  private tz: string;
  private archiveDeferred = new Set<string>();
  private lastFlushMessageCount = new Map<string, number>();

  constructor(sport: Sport, config: Config) {
    this.sport = sport;
    this.config = config;
    this.llm = new LLM(config);
    const { flushModel } = config.llm;
    this.flushLlm =
      flushModel !== undefined && flushModel !== config.llm.model
        ? new LLM({ ...config, llm: { ...config.llm, model: flushModel } })
        : this.llm;
    this.tz = resolveUserTimezone(config.session.timezone);
    this.memory = new Memory(config.dataDir, this.tz);
    this.chatStore = new ChatStore(config.dataDir, config.session.resetArchiveRetentionDays);

    const intervals = config.intervals.apiKey
      ? makeChatClient({
          apiKey: config.intervals.apiKey,
          athleteId: config.intervals.athleteId,
        })
      : null;

    const secrets: SecretsResolver = { resolve: resolveSecretRef };
    const coreDeps: CoreDeps = {
      llm: this.llm,
      intervals,
      memory: this.memory,
      secrets,
      tz: this.tz,
    };
    const registrations = sport.tools(coreDeps);
    this.tools = Object.fromEntries(registrations.map((r) => [r.name, r.tool])) as ToolSet;
    // systemPrompt is rebuilt at the top of every chat() call; no need to bake one here.
    this.systemPrompt = "";
  }

  private async flushMemory(
    messages: ModelMessage[],
    trigger: MemoryFlushTrigger,
  ): Promise<MemoryFlushOutcome> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_FLUSH_ATTEMPTS; attempt++) {
      try {
        return await runMemoryFlush({
          llm: this.flushLlm,
          messages,
          memory: this.memory,
          memorySections: getEffectiveSections(this.sport),
          tz: this.tz,
        });
      } catch (err) {
        lastError = err;
        console.warn(
          JSON.stringify({
            event: "memory_flush_failed",
            trigger,
            attempt,
            maxAttempts: MAX_FLUSH_ATTEMPTS,
            error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
          }),
        );
      }
    }
    throw lastError;
  }

  private compactionParams() {
    return {
      llm: this.llm,
      caller: "compact" as const,
      mustPreserveTokens: this.sport.mustPreserveTokens,
      memory: createMemorySnapshot(this.memory),
      contextWindowTokens: this.config.contextWindowTokens,
    };
  }

  async chat(chatId: string, userMessage: string): Promise<string> {
    return withSessionLock(chatId, async () => {
      const turnStart = Date.now();
      // One flush per turn: the latch flips on entry (before the await
      // resolves) so a thrown flush still consumes the turn's single flush.
      let flushedThisTurn = false;
      // Single file read: load history + last message time together
      let { messages: history, lastMessageTime } = this.chatStore.load(chatId);

      const { fresh } = evaluateSessionFreshness({
        lastMessageTime,
        dailyResetHour: this.config.session.dailyResetHour,
        idleMinutes: this.config.session.idleMinutes,
        tz: this.tz,
      });

      if (!fresh) {
        // Flush memory before reset, then archive
        let outcome: MemoryFlushOutcome | null = null;
        if (history.length > 0 && !flushedThisTurn) {
          flushedThisTurn = true;
          try {
            outcome = await this.flushMemory(history, "stale-reset");
          } catch (err) {
            console.warn("Pre-reset memory flush failed; archiving session anyway", err);
          }
        }
        const zeroWrite =
          outcome !== null &&
          outcome.writes === 0 &&
          outcome.ledgerAppends === 0 &&
          history.length >= FLUSH_ZERO_WRITE_MIN_MESSAGES;
        if (zeroWrite && !this.archiveDeferred.has(chatId)) {
          this.archiveDeferred.add(chatId);
          console.warn(
            JSON.stringify({
              event: "memory_flush_archive_deferred",
              messageCount: history.length,
            }),
          );
        } else {
          this.archiveDeferred.delete(chatId);
          this.chatStore.archiveAndReset(chatId);
          this.lastFlushMessageCount.delete(chatId);
          history = [];
        }
      }

      this.systemPrompt = buildSystemPrompt(this.sport, this.memory, this.tz);

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
      let requeued: ModelMessage[] = [];
      if (dropped.length > 0) {
        this.lastFlushMessageCount.set(chatId, history.length);
        let flushed = true;
        if (!flushedThisTurn) {
          flushedThisTurn = true;
          try {
            await this.flushMemory(history, "trim");
          } catch (err) {
            flushed = false;
            console.warn("Pre-compaction memory flush failed; keeping session file unchanged", err);
          }
        }
        try {
          const { summary, unsummarized } = await summarizeDroppedMessages({
            dropped,
            previousSummary,
            ...this.compactionParams(),
          });
          summaryMsg = makeSummaryMessage(summary);
          requeued = unsummarized;
          if (flushed) {
            this.chatStore.archivePreCompact(chatId);
            this.chatStore.overwriteHistory(chatId, [summaryMsg, ...requeued, ...kept]);
          }
        } catch (err) {
          console.warn("Dropped message summarization failed, continuing without summary", err);
          if (previousSummary) {
            summaryMsg = makeSummaryMessage(previousSummary);
          }
        }
      } else if (previousSummary) {
        summaryMsg = makeSummaryMessage(previousSummary);
      }

      if (
        dropped.length === 0 &&
        shouldRunMemoryFlush({
          estimatedTokens: estimateMessagesTokens(history),
          tokenBudget: budget,
          lastFlushMessageCount: this.lastFlushMessageCount.get(chatId) ?? 0,
          currentMessageCount: history.length,
        })
      ) {
        this.lastFlushMessageCount.set(chatId, history.length);
        if (!flushedThisTurn) {
          flushedThisTurn = true;
          try {
            await this.flushMemory(history, "soft-threshold");
          } catch (err) {
            console.warn("Soft-threshold memory flush failed; continuing turn", err);
          }
        }
      }

      // Append a fresh "Current time:" line to the user message so the LLM
      // always sees the athlete's local time on this turn — the cached system
      // prefix carries only the TZ name, not the date. Idempotent: safe
      // across the retry/compaction loop below.
      const userMessageWithTime = appendCurrentTimeLine(userMessage, this.tz);

      // Build messages array with new user message
      let messages: ModelMessage[] = [
        ...(summaryMsg ? [summaryMsg] : []),
        ...requeued,
        ...kept,
        { role: "user", content: userMessageWithTime },
      ];

      let overflowAttempts = 0;
      let timeoutAttempts = 0;
      let rateLimitAttempts = 0;

      while (true) {
        // Preemptive: compact before sending if over budget
        if (shouldCompact({ messages, systemPrompt: this.systemPrompt, contextWindowTokens: this.config.contextWindowTokens })) {
          if (!flushedThisTurn) {
            flushedThisTurn = true;
            try {
              await this.flushMemory(messages, "pre-compaction");
            } catch (err) {
              console.warn("In-turn memory flush failed; compacting without flush", err);
            }
          }
          messages = await summarizeInStages({ messages, ...this.compactionParams() });
          this.memory.reload();
        }

        try {
          const { text } = await this.llm.generate({
            system: this.systemPrompt,
            messages,
            tools: this.tools,
            stopWhen: stepCountIs(10),
            maxSteps: 10,
            caller: "chat",
            cacheKey: cacheKeyForChat(chatId),
          });

          const lineage = computePromptLineage({
            soul: this.sport.soul,
            skills: this.sport.skills,
            ruleBlocks: staticRuleBlocks(),
            toolSchemas: this.tools,
            model: this.config.llm.model,
            systemPrompt: this.systemPrompt,
            messages,
          });

          // Append BOTH after success — JSONL unchanged on failure
          this.chatStore.appendMessage(chatId, "user", userMessage);
          this.chatStore.appendMessage(chatId, "assistant", text, {
            templateHash: lineage.templateHash,
            assembledHash: lineage.assembledHash,
            provider: this.config.llm.provider,
            model: this.config.llm.model,
          });

          appendUsageLine(this.config.dataDir, {
            ts: Date.now(),
            kind: "turn",
            caller: "chat",
            provider: this.config.llm.provider,
            model: this.config.llm.model,
            durationMs: Date.now() - turnStart,
            steps: undefined,
            inputTokens: undefined,
            outputTokens: undefined,
            totalTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
            cost: undefined,
            stopReason: undefined,
          });

          return text;
        } catch (err) {
          // Reactive: context overflow → flush + compact + retry
          if (isContextOverflowError(err) && overflowAttempts < MAX_OVERFLOW_ATTEMPTS) {
            overflowAttempts++;
            try {
              if (!flushedThisTurn) {
                flushedThisTurn = true;
                try {
                  await this.flushMemory(messages, "overflow-recovery");
                } catch (flushErr) {
                  console.warn("In-turn memory flush failed; compacting without flush", flushErr);
                }
              }
              messages = await summarizeInStages({ messages, ...this.compactionParams() });
              this.memory.reload();
            } catch (rescueErr) {
              console.warn("Compaction rescue failed; rethrowing the original turn error", rescueErr);
              if (err instanceof Error && err.cause === undefined) {
                (err as Error & { cause?: unknown }).cause = rescueErr;
              }
              throw err;
            }
            continue;
          }
          // Timeout with high context usage → compact + retry (no flush)
          if (isTimeoutError(err) && timeoutAttempts < MAX_TIMEOUT_ATTEMPTS) {
            const ratio = estimateMessagesTokens(messages) / this.config.contextWindowTokens;
            if (ratio > TIMEOUT_COMPACTION_THRESHOLD) {
              timeoutAttempts++;
              try {
                messages = await summarizeInStages({ messages, ...this.compactionParams() });
                this.memory.reload();
              } catch (rescueErr) {
                console.warn("Compaction rescue failed; rethrowing the original turn error", rescueErr);
                if (err instanceof Error && err.cause === undefined) {
                  (err as Error & { cause?: unknown }).cause = rescueErr;
                }
                throw err;
              }
              continue;
            }
          }
          // Rate limit → backoff (respect retry-after) + retry
          if (isRateLimitError(err) && rateLimitAttempts < MAX_RATE_LIMIT_ATTEMPTS) {
            rateLimitAttempts++;
            const retryAfter = extractRetryAfterMs(err);
            const requestedMs = retryAfter
              ?? Math.min(
                   RATE_LIMIT_FALLBACK_BASE_MS * Math.pow(RATE_LIMIT_FALLBACK_MULTIPLIER, rateLimitAttempts - 1),
                   RATE_LIMIT_FALLBACK_MAX_MS,
                 );
            const backoff = Math.min(requestedMs, RATE_LIMIT_MAX_WAIT_MS);
            const clampNote = requestedMs > RATE_LIMIT_MAX_WAIT_MS
              ? ` (provider requested ${requestedMs}ms, clamped to ${RATE_LIMIT_MAX_WAIT_MS}ms)`
              : "";
            console.warn(`Rate limited (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_ATTEMPTS}), waiting ${backoff}ms${clampNote}`);
            await sleep(backoff);
            continue;
          }
          // Rate limit retries exhausted → throw to caller (skip compaction — API is rate limited)
          throw err;
        }
      }
    });
  }

  hasSession(chatId: string): boolean {
    return this.chatStore.hasSession(chatId);
  }

  async resetSession(chatId: string): Promise<{ memoryFlushed: boolean }> {
    // Flush before reset to avoid losing un-persisted context
    let memoryFlushed = true;
    let history: ModelMessage[] = [];
    try {
      ({ messages: history } = this.chatStore.load(chatId));
    } catch (err) {
      memoryFlushed = false;
      console.warn("Pre-reset session load failed; archiving session anyway", err);
    }
    if (history.length > 0) {
      try {
        await this.flushMemory(history, "explicit-reset");
      } catch (err) {
        memoryFlushed = false;
        console.warn("Pre-reset memory flush failed; archiving session anyway", err);
      }
    }
    this.archiveDeferred.delete(chatId);
    this.chatStore.archiveAndReset(chatId);
    this.lastFlushMessageCount.delete(chatId);
    return { memoryFlushed };
  }

  getMemory(): Memory {
    return this.memory;
  }
}
