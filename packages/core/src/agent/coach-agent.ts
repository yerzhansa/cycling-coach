import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stepCountIs } from "ai";
import type { FinishReason, ModelMessage, Tool, ToolSet } from "ai";
import { makeChatClient } from "../reference/sync/intervals-client-factory.js";
import { getEffectiveSections } from "../memory/effective-sections.js";
import type { CoreDeps, Sport } from "../sport.js";
import type { ResolvedCs } from "../reference/cs-resolution.js";
import type { SecretsResolver } from "../secrets/types.js";
import type { Config } from "../config.js";
import { resolveSecretRef } from "../secrets/resolve.js";
import { safeReadJson } from "../io/safe-read-json.js";
import {
  ErrorStateSchema,
  type ErrorState,
  LatestJsonSchema,
  type LatestJson,
} from "../reference/index.js";
import { Memory } from "../memory/store.js";
import { ChatStore } from "./chat-store.js";
import { buildSystemPrompt, staticRuleBlocks } from "./system-prompt.js";
import { computeAssembledHash, computeTemplateHash, sha256_16 } from "./prompt-lineage.js";
import { withSessionLock } from "./session-lock.js";
import { capToolResult, TOOL_RESULT_SHARE } from "./tool-result-cap.js";
import { memoizeReadTool } from "./read-memoizer.js";
import { splitHistoryByBudget, makeSummaryMessage } from "./history-limit.js";
import {
  shouldCompact,
  computeHistoryTokenBudget,
  isContextOverflowError,
  isTimeoutError,
  isRateLimitError,
  classifyFailure,
  extractRetryAfterMs,
  estimateMessagesTokens,
  TIMEOUT_COMPACTION_THRESHOLD,
} from "./token-utils.js";
import { summarizeInStages, summarizeDroppedMessages } from "./compaction.js";
import { runMemoryFlush, FLUSH_ZERO_WRITE_MIN_MESSAGES, shouldRunMemoryFlush } from "./memory-flush.js";
import type { MemoryFlushOutcome } from "./memory-flush.js";
import { evaluateSessionFreshness } from "./session-freshness.js";
import { LLM } from "../llm.js";
import { appendUsageLine, usageFieldsFromResult } from "../usage-ledger.js";
import { createMemorySnapshot } from "../memory/snapshot.js";
import { resolveUserTimezone, appendCurrentTimeLine } from "./user-time.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/index.js";
import { retryWithBackoff } from "../concurrency/retry.js";
import { createTurnBudget, TurnBudgetExceededError, type TurnBudget } from "./turn-budget.js";
import { TAINTED_BY_WRITES_MESSAGE, STEP_LIMIT_TRUNCATION_MESSAGE } from "./coach-agent-copy.js";

const MAX_OVERFLOW_ATTEMPTS = 3;
const MAX_TIMEOUT_ATTEMPTS = 2;
const MAX_PLAIN_TIMEOUT_ATTEMPTS = 1;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const MAX_SERVER_ERROR_ATTEMPTS = 2;
const SERVER_ERROR_BACKOFF_BASE_MS = 500;
const SERVER_ERROR_BACKOFF_MAX_MS = 5_000;

// The AI-SDK path exposes Retry-After via APICallError response headers
// (extractRetryAfterMs). Codex-normalized ServerError/RateLimitError instead
// carry the parsed hint as a numeric `retryAfterMs` property, so honor that too;
// otherwise the bridge parses a header the retry loop never reads.
function retryAfterFloorMs(err: unknown): number | null {
  const fromHeaders = extractRetryAfterMs(err);
  if (fromHeaders !== null) return fromHeaders;
  const carried = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof carried === "number" && Number.isFinite(carried) && carried > 0 ? carried : null;
}
const RATE_LIMIT_FALLBACK_BASE_MS = 5_000;
const RATE_LIMIT_FALLBACK_MULTIPLIER = 2;
const RATE_LIMIT_FALLBACK_MAX_MS = 30_000;
const RATE_LIMIT_MAX_WAIT_MS = 120_000;
const MAX_FLUSH_ATTEMPTS = 2;

const REPLAY_UNSAFE_TOOL_NAMES = new Set([
  "intervals_create_workout",
  "intervals_delete_workout",
  "memory_write",
  "plan_save",
  // Commits a plan via memory.savePlan — the same non-idempotent side effect as
  // plan_save — so a retry must not replay it. Recognized in committedWriteSummary.
  "build_plan_skeleton",
]);

// A turn that spent its whole step budget on tool calls (or hit the output-token
// cap) and never emitted final text. Kept a single named predicate so the future
// window-exceeded classification can extend the same switch rather than adding a
// competing finishReason branch.
function isStepExhaustedEmpty(text: string, finishReason: FinishReason): boolean {
  return text.trim() === "" && (finishReason === "tool-calls" || finishReason === "length");
}

const RECOVERY_PROMPT = "summarize what you did and what's left";

const DISK_FULL_NOTE =
  "\n\n(Heads up: my disk is full, so I couldn't save this to our history — but your message went through. Please free up some space when you can.)";

// Disk-full is a host condition, not a per-chat one, so the athlete is told
// once for the whole process rather than every turn the disk stays full.
let persistenceNoticeShown = false;

function noteForPersistenceFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "ENOSPC") return "";
  if (persistenceNoticeShown) return "";
  persistenceNoticeShown = true;
  return DISK_FULL_NOTE;
}

export function __resetPersistenceNoticeState(): void {
  persistenceNoticeShown = false;
}

type MemoryFlushTrigger =
  | "stale-reset"
  | "explicit-reset"
  | "trim"
  | "pre-compaction"
  | "overflow-recovery"
  | "soft-threshold";

// The per-turn terminal record. Field names are frozen by the operator spec:
// error_class and duration_ms are snake_case, and the three *Attempts mirror the
// in-scope retry counters exactly.
interface TurnOutcome {
  turnId: string;
  chatId: string;
  ok: boolean;
  error_class?: string;
  overflowAttempts: number;
  timeoutAttempts: number;
  rateLimitAttempts: number;
  duration_ms: number;
  compactions: number;
}

interface TurnWriteRecord {
  writesCommitted: number;
  lastWriteSummary?: string;
}

function classifyError(err: unknown): string {
  // TurnBudgetExceededError crosses a dynamic-import boundary in tests, so match
  // on the structural name rather than instanceof.
  if (err instanceof Error && err.name === "TurnBudgetExceededError") return "budget";
  if (isContextOverflowError(err)) return "overflow";
  if (isTimeoutError(err)) return "timeout";
  if (isRateLimitError(err)) return "rate_limit";
  return "unknown";
}

// Replays a pre-captured error to retryWithBackoff exactly once so it performs a
// single capped backoff sleep: the first invocation rethrows `err`, the second
// resolves. All scheduling (jitter, retry-after floor, onRetry) stays in opts.
function backoffWithSentinelError(
  err: unknown,
  opts: Parameters<typeof retryWithBackoff>[1],
): Promise<void> {
  let retried = false;
  return retryWithBackoff(async () => {
    if (!retried) {
      retried = true;
      throw err;
    }
  }, opts);
}

function committedWriteSummary(name: string, result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const out = result as { created?: unknown; deleted?: unknown; saved?: unknown; phases?: unknown };
  if (out.created === true) return "created a workout on the calendar";
  if (out.deleted === true) return "deleted a scheduled workout";
  if (out.saved === true && name === "memory_write") return "saved athlete memory";
  if (out.saved === true && name === "plan_save") return "saved the training plan";
  // build_plan_skeleton returns the saved plan itself (a phases-bearing object),
  // not a {saved:true} ack, so recognize its success by the plan shape.
  if (name === "build_plan_skeleton" && Array.isArray(out.phases)) return "built training plan";
  return undefined;
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
  private log: SubsystemLogger;
  private tools: ToolSet;
  private systemPrompt: string;
  private tz: string;
  private archiveDeferred = new Set<string>();
  private lastFlushMessageCount = new Map<string, number>();
  // A committed tool write makes the turn non-replayable: the retry loop re-sends
  // the pre-turn messages, so a second generate could re-run the write. Keep it
  // in async-local turn state so concurrent chats cannot reset each other.
  private readonly turnWritesStore = new AsyncLocalStorage<TurnWriteRecord>();
  // Per-turn read memoizer cache. Held in async-context storage (mirroring
  // resolvedCsStore below) rather than a shared instance field so that
  // concurrent fire-and-forget turns each memoize into their OWN map and can
  // neither read nor clear another turn's entries; chat() runs every turn
  // inside a fresh map. The wrapped read tools (built once at construction)
  // resolve the running turn's map lazily through this store.
  private readonly readToolCacheStore = new AsyncLocalStorage<Map<string, unknown>>();
  // Resolved primary anchor (running CS) for the in-flight turn. Held in
  // async-context storage rather than a shared instance field so that
  // fire-and-forget turns running concurrently (different chats, or rapid
  // same-chat sends whose synchronous prologues interleave before each turn's
  // lock body resumes) each read their OWN anchor — a shared field would let a
  // later turn's value clobber an in-flight turn's and compute zones from the
  // wrong athlete's critical speed. The getter (read lazily by sport tools via
  // the `coreDeps.resolvedCs` closure) resolves against the running turn's
  // context, so the tool set and cached template hash still never rebuild.
  private readonly resolvedCsStore = new AsyncLocalStorage<ResolvedCs | null>();
  // The prompt-template hash is derived from constructor-stable inputs (soul,
  // skills, tool schemas, model, and the compile-time rule-block set), so it is
  // computed once on first use and reused for every turn of the process.
  private templateHash?: string;

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
    this.log = createSubsystemLogger("agent", config.dataDir);

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
      resolvedCs: () => this.resolvedCsStore.getStore() ?? null,
    };
    const registrations = sport.tools(coreDeps);
    const maxResultTokens = Math.floor(this.config.contextWindowTokens * TOOL_RESULT_SHARE);
    this.tools = Object.fromEntries(
      registrations.map((r) => [
        r.name,
        memoizeReadTool(
          r.name,
          this.wrapWriteTool(r.name, capToolResult(r.tool, { maxResultTokens })),
          () => this.readToolCacheStore.getStore(),
        ),
      ]),
    ) as ToolSet;
    // systemPrompt is rebuilt at the top of every chat() call; no need to bake one here.
    this.systemPrompt = "";
  }

  // Agent-owned wrapper that records a committed tool write the moment its
  // tool executes — at the execution boundary, not from the generate result,
  // because result.toolCalls carries only the last agentic step and would miss
  // a write committed on an earlier step. Non-write tools pass through untouched.
  private wrapWriteTool(name: string, tool: Tool): Tool {
    if (!REPLAY_UNSAFE_TOOL_NAMES.has(name)) return tool;
    const inner = tool.execute;
    if (typeof inner !== "function") return tool;
    return {
      ...tool,
      execute: async (input: unknown, options: unknown) => {
        const result = await (inner as (i: unknown, o: unknown) => unknown)(input, options);
        const summary = committedWriteSummary(name, result);
        const record = this.turnWritesStore.getStore();
        if (record !== undefined && summary !== undefined) {
          record.writesCommitted++;
          record.lastWriteSummary = summary;
        }
        return result;
      },
    } as Tool;
  }

  /**
   * Read the sync error-state once at turn start and, when the last sync was
   * rejected for a corruption-class (HARD) failure, return a degrade-and-disclose
   * instruction block for the volatile prompt tail. The READ itself fails OPEN:
   * a missing, unparseable, or schema-invalid error-state file must never brick
   * a chat turn, so `safeReadJson` returning null yields no block.
   */
  private buildDegradeBlock(): string | undefined {
    const referenceDir = join(this.config.dataDir, "data");
    const errorState = safeReadJson<ErrorState>(
      join(referenceDir, "error_state.json"),
      ErrorStateSchema,
    );
    if (errorState?.mitigation !== "block_coaching") return undefined;

    // Prefer the cache's last successful-sync stamp as the "last synced" anchor;
    // fall back to the failure timestamp when the cache is unavailable.
    const latest = safeReadJson<LatestJson>(
      join(referenceDir, "latest.json"),
      LatestJsonSchema,
    );
    const lastSynced = latest?.metadata?.last_updated ?? errorState.ts;

    return (
      "# Data Freshness — DEGRADED\n\n" +
      "The latest training data could not be validated, so the on-disk cache " +
      "may be stale or corrupt. You MUST NOT quote specific numbers (paces, " +
      "power, Load, Fitness, Fatigue, Form, heart rate, durations) from that " +
      "data — they cannot be trusted. Give general, qualitative guidance only. " +
      "Open your reply by disclosing the staleness to the athlete, in your own " +
      `voice, matching this posture: "Your training data hasn't synced since ` +
      `${lastSynced}, so I won't base numbers on it — here's general guidance ` +
      `only." State the last-synced time in natural language (e.g. a date or "a ` +
      `few days ago"); do not echo the raw timestamp verbatim. Then help as best ` +
      `you can without fabricating figures.`
    );
  }

  private async flushMemory(
    messages: ModelMessage[],
    trigger: MemoryFlushTrigger,
    budget?: Pick<TurnBudget, "chargeModelCall">,
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
          budget,
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

  // Step-exhaustion recovery: when the model spent all 10 steps on tool calls
  // (or hit the output cap) and never emitted final text, run one no-tools
  // completion asking it to summarize. If that yields nothing (or throws), fall
  // to the static floor — the athlete always gets actionable text and is never
  // told to blindly "try again", which would re-run already-committed paid side
  // effects. The recovery call carries NO tools, so it cannot commit a new write.
  private async recoverStepExhaustedText(
    text: string,
    finishReason: FinishReason,
    messages: ModelMessage[],
    cacheKey: string,
    turnBudget: TurnBudget,
  ): Promise<string> {
    if (!isStepExhaustedEmpty(text, finishReason)) return text;
    // Charge OUTSIDE the recovery try/catch: a TurnBudgetExceededError is
    // terminal everywhere else in the turn loop, so it must propagate to the
    // outer terminal-budget handler, not degrade to the static floor.
    turnBudget.chargeModelCall();
    try {
      const recovery = await this.llm.generate({
        system: this.systemPrompt,
        messages: [...messages, { role: "user", content: RECOVERY_PROMPT }],
        tools: undefined,
        caller: "chat",
        cacheKey,
        deadlineMs: turnBudget.remainingMs(),
      });
      return recovery.text.trim() !== "" ? recovery.text : STEP_LIMIT_TRUNCATION_MESSAGE;
    } catch (recoveryErr) {
      console.warn("Step-limit recovery completion failed; using truncation floor", recoveryErr);
      return STEP_LIMIT_TRUNCATION_MESSAGE;
    }
  }

  private compactionParams(budget?: Pick<TurnBudget, "chargeModelCall">) {
    return {
      llm: this.llm,
      caller: "compact" as const,
      mustPreserveTokens: this.sport.mustPreserveTokens,
      memory: createMemorySnapshot(this.memory),
      contextWindowTokens: this.config.contextWindowTokens,
      budget,
    };
  }

  private emitTurnOutcome(outcome: TurnOutcome): void {
    // An observability write must never break a turn: a failed outcome emit is
    // swallowed exactly like the usage-ledger and substrate writes.
    try {
      this.log.info("turn_outcome", { ...outcome });
    } catch {
      // Swallow.
    }
  }

  async chat(
    chatId: string,
    userMessage: string,
    turn?: { resolvedCs?: ResolvedCs | null },
  ): Promise<string> {
    // Per-turn anchor, read lazily by sport tools through the coreDeps getter.
    // Scoped to this turn's async context (not a shared field) so concurrent
    // fire-and-forget turns never clobber each other's anchor. null when the
    // channel supplies nothing (CLI path, no sync data).
    const resolvedCs = turn?.resolvedCs ?? null;
    const turnWrites: TurnWriteRecord = { writesCommitted: 0 };
    return this.resolvedCsStore.run(resolvedCs, () =>
      this.readToolCacheStore.run(new Map<string, unknown>(), () =>
        this.turnWritesStore.run(turnWrites, () =>
          withSessionLock(chatId, async () => {
      const turnStart = Date.now();
      const turnId = randomUUID();
      let compactions = 0;
      const turnBudget = createTurnBudget(() => Date.now());
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
            outcome = await this.flushMemory(history, "stale-reset", turnBudget);
          } catch (err) {
            this.log.warn("Pre-reset memory flush failed; archiving session anyway", err);
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

      this.systemPrompt = buildSystemPrompt(
        this.sport,
        this.memory,
        this.tz,
        this.buildDegradeBlock(),
      );

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
            await this.flushMemory(history, "trim", turnBudget);
          } catch (err) {
            flushed = false;
            this.log.warn("Pre-compaction memory flush failed; keeping session file unchanged", err);
          }
        }
        try {
          const { summary, unsummarized } = await summarizeDroppedMessages({
            dropped,
            previousSummary,
            ...this.compactionParams(turnBudget),
          });
          compactions++;
          summaryMsg = makeSummaryMessage(summary);
          requeued = unsummarized;
          if (flushed) {
            this.chatStore.archivePreCompact(chatId);
            this.chatStore.overwriteHistory(chatId, [summaryMsg, ...requeued, ...kept]);
          }
        } catch (err) {
          this.log.warn("Dropped message summarization failed, continuing without summary", err);
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
            await this.flushMemory(history, "soft-threshold", turnBudget);
          } catch (err) {
            this.log.warn("Soft-threshold memory flush failed; continuing turn", err);
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
      let plainTimeoutAttempts = 0;
      let rateLimitAttempts = 0;
      let serverErrorAttempts = 0;

      // Loop-invariant: the prompt cache key derives only from the chat id.
      const cacheKey = sha256_16(chatId);

      try {
        while (true) {
          // Between-attempt budget gates: the attempt charge and the wall-clock
          // check run at the loop top so the deadline stops the NEXT attempt and
          // never aborts a generate/compaction already in flight.
          turnBudget.chargeAttempt();
          turnBudget.checkDeadline();

          // Preemptive: compact before sending if over budget
          if (shouldCompact({ messages, systemPrompt: this.systemPrompt, contextWindowTokens: this.config.contextWindowTokens })) {
            if (!flushedThisTurn) {
              flushedThisTurn = true;
              try {
                await this.flushMemory(messages, "pre-compaction", turnBudget);
              } catch (err) {
                this.log.warn("In-turn memory flush failed; compacting without flush", err);
              }
            }
            messages = await summarizeInStages({ messages, ...this.compactionParams(turnBudget) });
            compactions++;
            this.memory.reload();
          }

          try {
            turnBudget.chargeModelCall();
            const result = await this.llm.generate({
              system: this.systemPrompt,
              messages,
              tools: this.tools,
              stopWhen: stepCountIs(10),
              maxSteps: 10,
              caller: "chat",
              cacheKey,
              // Cap this call by the turn's remaining wall-clock budget so a retry
              // after an early timeout inherits only the time the turn has left.
              deadlineMs: turnBudget.remainingMs(),
            });
            const { text, finishReason } = result;

            // Recovery runs only on this success path (before the catch below).
            const effectiveText = await this.recoverStepExhaustedText(
              text,
              finishReason,
              messages,
              cacheKey,
              turnBudget,
            );

            const templateHash = (this.templateHash ??= computeTemplateHash({
              soul: this.sport.soul,
              skills: this.sport.skills,
              ruleBlocks: staticRuleBlocks(),
              toolSchemas: this.tools,
              model: this.config.llm.model,
            }));
            const assembledHash = computeAssembledHash(this.systemPrompt, messages);

            // Append BOTH after success as one atomic write — JSONL unchanged
            // on failure, no dangling user line on a partial write.
            let persistenceNote = "";
            try {
              this.chatStore.appendTurn(chatId, userMessage, effectiveText, {
                templateHash,
                assembledHash,
                provider: this.config.llm.provider,
                model: this.config.llm.model,
              });
            } catch (persistErr) {
              // Deliver-first: a full disk or permission error must never
              // discard a reply the athlete already paid for. Swallow the
              // persistence throw, warn once, and still return the reply.
              console.warn("Session persistence failed; delivering reply unsaved", persistErr);
              persistenceNote = noteForPersistenceFailure(persistErr);
            }

            // A turn can run several generations (retry/compaction/overflow
            // recovery); these usage/cost figures are the FINAL successful
            // generation's only — not a turn-wide sum across attempts. A true
            // accumulator over all attempts is deferred.
            appendUsageLine(this.config.dataDir, {
              ts: Date.now(),
              kind: "turn",
              caller: "chat",
              provider: this.config.llm.provider,
              model: this.config.llm.model,
              durationMs: Date.now() - turnStart,
              templateHash,
              ...usageFieldsFromResult(result),
            });

            this.emitTurnOutcome({
              turnId,
              chatId,
              ok: true,
              overflowAttempts,
              timeoutAttempts,
              rateLimitAttempts,
              duration_ms: Date.now() - turnStart,
              compactions,
            });

            return effectiveText + persistenceNote;
          } catch (err) {
            // The classified budget error is terminal: re-throw it before any
            // retry branch so a future reordering can never mistake it for one of
            // the retryable classes and swallow it.
            if (err instanceof TurnBudgetExceededError) throw err;
            // A committed tool write makes this turn non-replayable: retrying
            // would re-send the pre-turn messages and could re-run the write.
            const committedWrites = this.turnWritesStore.getStore() ?? turnWrites;
            if (committedWrites.writesCommitted > 0) {
              console.warn(
                JSON.stringify({
                  event: "turn_failed_after_write",
                  writesCommitted: committedWrites.writesCommitted,
                  lastWriteSummary: committedWrites.lastWriteSummary,
                  error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
                }),
              );
              this.emitTurnOutcome({
                turnId,
                chatId,
                ok: false,
                error_class: classifyError(err),
                overflowAttempts,
                timeoutAttempts,
                rateLimitAttempts,
                duration_ms: Date.now() - turnStart,
                compactions,
              });
              return TAINTED_BY_WRITES_MESSAGE;
            }
            // Reactive: context overflow → flush + compact + retry
            if (isContextOverflowError(err) && overflowAttempts < MAX_OVERFLOW_ATTEMPTS) {
              overflowAttempts++;
              try {
                if (!flushedThisTurn) {
                  flushedThisTurn = true;
                  try {
                    await this.flushMemory(messages, "overflow-recovery", turnBudget);
                  } catch (flushErr) {
                    this.log.warn("In-turn memory flush failed; compacting without flush", flushErr);
                  }
                }
                messages = await summarizeInStages({ messages, ...this.compactionParams(turnBudget) });
                compactions++;
                this.memory.reload();
              } catch (rescueErr) {
                this.log.warn("Compaction rescue failed; rethrowing the original turn error", rescueErr);
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
                  messages = await summarizeInStages({ messages, ...this.compactionParams(turnBudget) });
                  compactions++;
                  this.memory.reload();
                } catch (rescueErr) {
                  this.log.warn("Compaction rescue failed; rethrowing the original turn error", rescueErr);
                  if (err instanceof Error && err.cause === undefined) {
                    (err as Error & { cause?: unknown }).cause = rescueErr;
                  }
                  throw err;
                }
                continue;
              }
              if (plainTimeoutAttempts < MAX_PLAIN_TIMEOUT_ATTEMPTS) {
                plainTimeoutAttempts++;
                timeoutAttempts++;
                continue;
              }
            }
            // Rate limit → backoff (respect retry-after) + retry
            if (isRateLimitError(err) && rateLimitAttempts < MAX_RATE_LIMIT_ATTEMPTS) {
              rateLimitAttempts++;
              const attemptNo = rateLimitAttempts;
              // The server hint (if any) is a lower bound; absent one, fall back to a
              // capped exponential. Either feeds the primitive as the Retry-After
              // floor so the 120s ceiling and the clamp note are honored bit-for-bit.
              const requestedMs = retryAfterFloorMs(err)
                ?? Math.min(
                     RATE_LIMIT_FALLBACK_BASE_MS * RATE_LIMIT_FALLBACK_MULTIPLIER ** (attemptNo - 1),
                     RATE_LIMIT_FALLBACK_MAX_MS,
                   );
              const clampNote = requestedMs > RATE_LIMIT_MAX_WAIT_MS
                ? ` (provider requested ${requestedMs}ms, clamped to ${RATE_LIMIT_MAX_WAIT_MS}ms)`
                : "";
              await backoffWithSentinelError(err, {
                attempts: 2,
                baseMs: requestedMs,
                capMs: RATE_LIMIT_MAX_WAIT_MS,
                shouldRetry: () => true,
                retryAfterMs: () => requestedMs,
                random: () => 0,
                onRetry: ({ delayMs }) => {
                  console.warn(`Rate limited (attempt ${attemptNo}/${MAX_RATE_LIMIT_ATTEMPTS}), waiting ${delayMs}ms${clampNote}`);
                },
              });
              // The backoff sleep is the one place a turn can silently burn
              // minutes; converting a long Retry-After wait into a clean budget
              // stop here means the deadline never wedges the session lock.
              turnBudget.checkDeadline();
              continue;
            }
            // Transient server (5xx) or network failure → brief jittered retry.
            // The residual class: only fires when overflow/timeout/rate_limit did
            // not match, so a single 502 or connection blip no longer kills the
            // turn on attempt 1 and discards paid multi-step tool work.
            const failure = classifyFailure(err);
            // A codex network throw is surfaced as a single attempt and tagged
            // NetworkError by the bridge's normalizeError. We deliberately cap the
            // codex network class at zero outer retries to keep it at exactly one
            // layer; the outer network retry below is for the AI-SDK path, whose
            // errors are plain TypeErrors (not name="NetworkError") and whose SDK
            // does zero retries. (Unifying codex network retry with the AI-SDK
            // path is tracked as a follow-up.)
            const alreadyRetriedNetwork = failure === "network" && err instanceof Error && err.name === "NetworkError";
            if (
              (failure === "server_error" || failure === "network") &&
              !alreadyRetriedNetwork &&
              serverErrorAttempts < MAX_SERVER_ERROR_ATTEMPTS
            ) {
              serverErrorAttempts++;
              const retryAfterFloor = retryAfterFloorMs(err);
              await backoffWithSentinelError(err, {
                attempts: 2,
                baseMs: retryAfterFloor ?? SERVER_ERROR_BACKOFF_BASE_MS,
                capMs: SERVER_ERROR_BACKOFF_MAX_MS,
                shouldRetry: () => true,
                retryAfterMs: () => retryAfterFloor,
              });
              turnBudget.checkDeadline();
              continue;
            }
            // Rate limit retries exhausted → throw to caller (skip compaction — API is rate limited)
            throw err;
          }
        }
      } catch (terminalErr) {
        // Single failure-emit point: every terminal throw out of the loop is one
        // failed turn, so the outcome line fires exactly once before the rethrow.
        this.emitTurnOutcome({
          turnId,
          chatId,
          ok: false,
          error_class: classifyError(terminalErr),
          overflowAttempts,
          timeoutAttempts,
          rateLimitAttempts,
          duration_ms: Date.now() - turnStart,
          compactions,
        });
        throw terminalErr;
      }
      }),
        ),
      ),
    );
  }

  hasSession(chatId: string): boolean {
    return this.chatStore.hasSession(chatId);
  }

  async resetSession(chatId: string): Promise<{ memoryFlushed: boolean }> {
    // Run under the same per-chat lock chat() uses so a reset cannot interleave
    // with an in-flight turn for the same chat (which would archive history the
    // turn is mid-write on).
    return withSessionLock(chatId, async () => {
      // Flush before reset to avoid losing un-persisted context
      let memoryFlushed = true;
      let history: ModelMessage[] = [];
      try {
        ({ messages: history } = this.chatStore.load(chatId));
      } catch (err) {
        memoryFlushed = false;
        this.log.warn("Pre-reset session load failed; archiving session anyway", err);
      }
      if (history.length > 0) {
        try {
          await this.flushMemory(history, "explicit-reset");
        } catch (err) {
          memoryFlushed = false;
          this.log.warn("Pre-reset memory flush failed; archiving session anyway", err);
        }
      }
      this.archiveDeferred.delete(chatId);
      this.chatStore.archiveAndReset(chatId);
      this.lastFlushMessageCount.delete(chatId);
      return { memoryFlushed };
    });
  }

  getMemory(): Memory {
    return this.memory;
  }
}
