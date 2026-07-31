import { stepCountIs } from "ai";
import type { FinishReason, ModelMessage, Tool, ToolSet } from "ai";
import { retryWithBackoff } from "@enduragent/kernel/concurrency";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import type { TurnEvent, TurnEventHandler } from "@enduragent/coach-contract";
import type {
  ChatStorePort,
  EngineConfig,
  EngineHostPorts,
  LoggerPort,
  MemoryStorePort,
  ToolConfirmationPort,
  TranscriptCompletedTurnInput,
} from "../host-ports.js";
import type { Sport, SportRuntimePorts } from "../sport.js";
import { getEffectiveSections } from "../sport/effective-sections.js";
import {
  ATHLETE_CONTEXT_MAX_CHARS,
  buildSystemPrompt,
  staticRuleBlocks,
} from "./system-prompt.js";
import {
  computeAssembledHash,
  computeTemplateHash,
  PROMPT_LINEAGE_SCHEMA_VERSION,
  sha256_16,
} from "./prompt-lineage.js";
import { withSessionLock } from "./session-lock.js";
import { capToolResult, TOOL_RESULT_SHARE } from "./tool-result-cap.js";
import { memoizeReadTool } from "./read-memoizer.js";
import { createTurnContext, getTurnContext, type TurnContext } from "./turn-context.js";
import { markUntrustedResult, isUntrustedEnvelope } from "./prompt-fence.js";
import { renderGarminAttribution } from "./garmin-attribution.js";
import { provenanceFromToolResult } from "./tool-provenance.js";
import {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  provenanceOfMessages,
  setMessageProvenance,
  unionProvenance,
  type SourceProvenance,
} from "../provenance.js";
import { splitHistoryByBudget, makeSummaryMessage } from "./history-limit.js";
import {
  shouldCompact,
  computeHistoryTokenBudget,
  estimateMessagesTokens,
  TIMEOUT_COMPACTION_THRESHOLD,
} from "./token-utils.js";
import { summarizeInStages, summarizeDroppedMessages } from "./compaction.js";
import {
  runMemoryFlush,
  FLUSH_ZERO_WRITE_MIN_MESSAGES,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import type { MemoryFlushOutcome } from "./memory-flush.js";
import { evaluateSessionFreshness } from "./session-freshness.js";
import { LLM } from "../llm.js";
import { usageFieldsFromResult } from "../llm-types.js";
import { createMemorySnapshot } from "../sport/memory-snapshot.js";
import { resolveUserTimezone, appendCurrentTimeLine } from "../sport/user-time.js";
import { createTurnBudget, TurnBudgetExceededError, type TurnBudget } from "./turn-budget.js";
import { TAINTED_BY_WRITES_MESSAGE, STEP_LIMIT_TRUNCATION_MESSAGE } from "./coach-agent-copy.js";

const MAX_OVERFLOW_ATTEMPTS = 3;
const MAX_TIMEOUT_ATTEMPTS = 2;
const MAX_PLAIN_TIMEOUT_ATTEMPTS = 1;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const MAX_SERVER_ERROR_ATTEMPTS = 2;
const SERVER_ERROR_BACKOFF_BASE_MS = 500;
const SERVER_ERROR_BACKOFF_MAX_MS = 5_000;

// The AI-SDK path exposes Retry-After via provider response headers
// (extractRetryAfterMs). Codex-normalized ServerError/RateLimitError instead
// carry the parsed hint as a numeric `retryAfterMs` property, so honor that too;
// otherwise the bridge parses a header the retry loop never reads.
function retryAfterFloorMs(
  err: unknown,
  extractRetryAfterMs: (error: unknown) => number | null,
): number | null {
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
  "intervals_create_strength_workout",
  "intervals_create_workout",
  "intervals_delete_workout",
  "memory_write",
  "plan_save",
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

interface RecoveredText {
  text: string;
  attributionBasis: "attempt" | "prompt" | "none";
}

type ClassifiedTurnFailure = ReturnType<EngineHostPorts["classifyFailure"]> | "budget";

function classifyError(
  err: unknown,
  classifyFailure: EngineHostPorts["classifyFailure"],
): ClassifiedTurnFailure {
  // TurnBudgetExceededError crosses a dynamic-import boundary in tests, so match
  // on the structural name rather than instanceof.
  if (err instanceof Error && err.name === "TurnBudgetExceededError") return "budget";
  return classifyFailure(err);
}

function transcriptWriteFailureReason(
  error: unknown,
): "record-too-large" | "storage-full" | "permission-denied" | "unsafe-target" | "write-failed" {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "TRANSCRIPT_RECORD_TOO_LARGE") return "record-too-large";
  if (code === "ENOSPC") return "storage-full";
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (
    code === "ELOOP" ||
    code === "EISDIR" ||
    code === "ENOTDIR" ||
    code === "TRANSCRIPT_UNSAFE_TARGET"
  ) {
    return "unsafe-target";
  }
  return "write-failed";
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
  // wrapWriteTool composes innermost (inside markUntrustedResult and the cap),
  // so the ack inspected here is the tool's raw result.
  if (result === null || typeof result !== "object") return undefined;
  const out = result as { created?: unknown; deleted?: unknown; saved?: unknown };
  if (out.created === true) return "created a workout on the calendar";
  if (out.deleted === true) return "deleted a scheduled workout";
  if (out.saved === true && name === "memory_write") return "saved athlete memory";
  if (out.saved === true && name === "plan_save") return "saved the training plan";
  return undefined;
}

export function gateMutatingTool(
  name: string,
  tool: Tool,
  confirmations: ToolConfirmationPort | undefined,
  prepareRun?: (
    name: string,
    ctx: TurnContext | undefined,
    run: () => Promise<unknown>,
  ) => () => Promise<unknown>,
): Tool {
  if (confirmations === undefined || !confirmations.gatedToolNames.has(name)) return tool;
  const inner = tool.execute;
  if (typeof inner !== "function") return tool;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const ctx = getTurnContext(options);
      const chatId = ctx?.chatId;
      if (chatId === undefined || chatId === "") return { error: "confirmation_unavailable" };
      const run = () =>
        (inner as (i: unknown, o: unknown) => Promise<unknown>)(input, {} as never);
      return confirmations.propose({
        chatId,
        toolName: name,
        toolInput: input,
        run: prepareRun === undefined ? run : prepareRun(name, ctx, run),
      });
    },
  } as Tool;
}

// ============================================================================
// AGENT
// ============================================================================

export class CoachAgent {
  private sport: Sport;
  private llm: LLM;
  private flushLlm: LLM;
  private compactLlm: LLM;
  private compactContextWindowTokens: number;
  private config: EngineConfig;
  private ports: EngineHostPorts;
  private memory: MemoryStorePort;
  private chatStore: ChatStorePort;
  private log: LoggerPort;
  private tools: ToolSet;
  private systemPrompt: string;
  private tz: string;
  private archiveDeferred = new Set<string>();
  private lastFlushMessageCount = new Map<string, number>();
  private readonly confirmationGate: boolean;
  // The prompt-template hash is derived from constructor-stable inputs (soul,
  // skills, tool schemas, model, and the compile-time rule-block set), so it is
  // computed once on first use and reused for every turn of the process.
  private templateHash?: string;

  constructor(sport: Sport, ports: EngineHostPorts) {
    const config = ports.config;
    if (config.dataSource === "store" && ports.platform.athleteData === undefined) {
      throw new TypeError("Store data source requires an athlete data reader.");
    }
    this.sport = sport;
    this.config = config;
    this.ports = ports;
    this.llm = new LLM(config, ports);
    // Per-role lanes share one LLM instance per distinct model, so adding a
    // lane never needs pairwise equality checks against the existing ones.
    const llmByModel = new Map<string, LLM>([[config.llm.model, this.llm]]);
    const llmFor = (model: string): LLM => {
      let lane = llmByModel.get(model);
      if (lane === undefined) {
        lane = new LLM({ ...config, llm: { ...config.llm, model } }, ports);
        llmByModel.set(model, lane);
      }
      return lane;
    };
    this.flushLlm = llmFor(config.llm.flushModel ?? config.llm.model);
    const compactModel = config.llm.compactModel ?? config.llm.model;
    this.compactLlm = llmFor(compactModel);
    this.compactContextWindowTokens = config.compactContextWindowTokens;
    this.tz = resolveUserTimezone(config.session.timezone);
    this.memory = ports.memory;
    this.chatStore = ports.chatStore;
    this.log = ports.logger;

    const runtimePorts: SportRuntimePorts = {
      llm: this.llm,
      intervals: ports.platform.legacyClient,
      athleteData: ports.platform.athleteData,
      calendarMutations:
        ports.platform.legacyClient === null && ports.platform.athleteData === undefined
          ? undefined
          : ports.platform.calendarMutations,
      memory: this.memory,
      secrets: ports.secrets,
      bindMemoryToolProvenance: true,
      tz: this.tz,
      resolvedCs: (options: unknown) => getTurnContext(options)?.resolvedCs ?? null,
    };
    const confirmations = ports.toolConfirmations;
    this.confirmationGate = confirmations !== undefined && confirmations.gatedToolNames.size > 0;
    const registrations = sport.tools(runtimePorts);
    const maxResultTokens = Math.floor(this.config.contextWindowTokens * TOOL_RESULT_SHARE);
    const prepareConfirmedRun = (
      name: string,
      ctx: TurnContext | undefined,
      run: () => Promise<unknown>,
    ): (() => Promise<unknown>) => {
      if (name !== "plan_save") return run;
      const provenance = ctx?.provenance.value ?? UNKNOWN_PROVENANCE;
      return () => this.runWithWriteProvenance(provenance, run);
    };
    this.tools = Object.fromEntries(
      registrations.map((r) => [
        r.name,
        this.observeToolProvenance(
          r.name,
          memoizeReadTool(
            r.name,
            capToolResult(
              markUntrustedResult(
                this.wrapWriteTool(
                  r.name,
                  gateMutatingTool(r.name, r.tool, confirmations, prepareConfirmedRun),
                ),
              ),
              { maxResultTokens },
            ),
            (options: unknown) => getTurnContext(options)?.readToolCache,
          ),
        ),
      ]),
    ) as ToolSet;
    ports.onToolsAssembled?.(Object.freeze(Object.keys(this.tools)));
    // systemPrompt is rebuilt at the top of every chat() call; no need to bake one here.
    this.systemPrompt = "";
  }

  private runWithWriteProvenance<T>(provenance: SourceProvenance, fn: () => T): T {
    return this.memory.runWithWriteProvenance === undefined
      ? fn()
      : this.memory.runWithWriteProvenance(provenance, fn);
  }

  private observe(ctx: TurnContext | undefined, provenance: SourceProvenance): void {
    if (ctx !== undefined) ctx.provenance.value = unionProvenance(ctx.provenance.value, provenance);
  }

  private observeToolProvenance(name: string, tool: Tool): Tool {
    const inner = tool.execute;
    if (typeof inner !== "function") return tool;
    return {
      ...tool,
      execute: async (input: unknown, options: unknown) => {
        const result = await (inner as (i: unknown, o: unknown) => unknown)(input, options);
        const ctx = getTurnContext(options);
        this.observe(ctx, provenanceFromToolResult(name, result));
        if (
          name === "calculate_zones" &&
          (() => {
            const visible = isUntrustedEnvelope(result) ? result.data : result;
            return (
              visible !== null &&
              typeof visible === "object" &&
              (visible as { anchorOrigin?: unknown }).anchorOrigin === "auto-resolved"
            );
          })()
        ) {
          this.observe(ctx, ctx?.referenceProvenance ?? EMPTY_PROVENANCE);
        }
        return result;
      },
    } as Tool;
  }

  // Agent-owned wrapper that records a committed tool write the moment its
  // tool executes — at the execution boundary, not from the generate result,
  // because result.toolCalls carries only the last agentic step and would miss
  // a write committed on an earlier step. Non-write tools pass through untouched.
  // Composed innermost so it inspects the raw ack (before the untrusted-data
  // envelope and the size cap can reshape it).
  private wrapWriteTool(name: string, tool: Tool): Tool {
    if (!REPLAY_UNSAFE_TOOL_NAMES.has(name)) return tool;
    const inner = tool.execute;
    if (typeof inner !== "function") return tool;
    return {
      ...tool,
      execute: async (input: unknown, options: unknown) => {
        const ctx = getTurnContext(options);
        const result = await this.runWithWriteProvenance(
          ctx?.provenance.value ?? UNKNOWN_PROVENANCE,
          () => (inner as (i: unknown, o: unknown) => unknown)(input, options),
        );
        const summary = committedWriteSummary(name, result);
        const record = ctx?.turnWrites;
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
    if (this.config.dataSource === "store") return undefined;
    const { errorState, latest } = this.ports.readReferenceState();
    if (errorState?.mitigation !== "block_coaching") return undefined;

    // Prefer the cache's last successful-sync stamp as the "last synced" anchor;
    // fall back to the failure timestamp when the cache is unavailable.
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
    onTextDelta: (delta: string) => void,
  ): Promise<RecoveredText> {
    if (!isStepExhaustedEmpty(text, finishReason)) {
      return { text, attributionBasis: "attempt" };
    }
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
        onTextDelta,
      });
      return recovery.text.trim() !== ""
        ? { text: recovery.text, attributionBasis: "prompt" }
        : { text: STEP_LIMIT_TRUNCATION_MESSAGE, attributionBasis: "none" };
    } catch (recoveryErr) {
      console.warn("Step-limit recovery completion failed; using truncation floor", recoveryErr);
      return { text: STEP_LIMIT_TRUNCATION_MESSAGE, attributionBasis: "none" };
    }
  }

  private compactionParams(budget?: Pick<TurnBudget, "chargeModelCall">) {
    return {
      llm: this.compactLlm,
      caller: "compact" as const,
      mustPreserveTokens: this.sport.mustPreserveTokens,
      memory: createMemorySnapshot(this.memory),
      contextWindowTokens: this.compactContextWindowTokens,
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

  private recordCompletedTurn(input: TranscriptCompletedTurnInput): void {
    try {
      this.ports.transcriptWriter.appendCompletedTurn(input);
    } catch (error) {
      try {
        this.log.warn("transcript_record_failed", undefined, {
          operation: "turn-completed",
          reason: transcriptWriteFailureReason(error),
        });
      } catch {
        return;
      }
    }
  }

  async chat(
    chatId: string,
    userMessage: string,
    turn?: { resolvedCs?: ResolvedCs | null; referenceProvenance?: SourceProvenance },
    onEvent?: TurnEventHandler,
  ): Promise<string> {
    // One explicit context per turn, created synchronously before the session
    // lock is queued so rapid same-chat sends can never share turn state. Tool
    // wrappers and sport tools reach it through the tool-execution options, so
    // the tool set and cached template hash never rebuild. resolvedCs is null
    // when the channel supplies nothing (CLI path, no sync data).
    const ctx = createTurnContext(
      turn?.resolvedCs ?? null,
      chatId,
      turn?.referenceProvenance ?? EMPTY_PROVENANCE,
    );
    return withSessionLock(chatId, async () => {
      const turnStart = this.ports.now();
      const turnId = this.ports.randomId();
      const emitEvent = (event: TurnEvent): void => {
        try {
          onEvent?.(event);
        } catch {
          return;
        }
      };
      let compactions = 0;
      const turnBudget = createTurnBudget(this.ports.now);
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
          this.chatStore.resetConversation({
            chatId,
            boundaryAt: new Date(this.ports.now()).toISOString(),
            reason: "stale-reset",
          });
          this.archiveDeferred.delete(chatId);
          this.lastFlushMessageCount.delete(chatId);
          history = [];
        }
      }

      this.systemPrompt = buildSystemPrompt(
        this.sport,
        this.memory,
        this.tz,
        this.buildDegradeBlock(),
        { confirmationGate: this.confirmationGate },
      );
      const contextProvenance =
        this.memory.getContextWithProvenance?.({ maxChars: ATHLETE_CONTEXT_MAX_CHARS })
          .provenance ?? EMPTY_PROVENANCE;

      const budget = computeHistoryTokenBudget({
        contextWindowTokens: this.config.contextWindowTokens,
        systemPrompt: this.systemPrompt,
        budgetRatio: this.config.session.historyTokenBudgetRatio,
      });
      const { kept, dropped, previousSummary, previousSummaryProvenance } = splitHistoryByBudget({
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
            this.log.warn(
              "Pre-compaction memory flush failed; keeping session file unchanged",
              err,
            );
          }
        }
        try {
          const { summary, unsummarized } = await summarizeDroppedMessages({
            dropped,
            previousSummary,
            ...this.compactionParams(turnBudget),
          });
          compactions++;
          summaryMsg = makeSummaryMessage(
            summary,
            unionProvenance(previousSummaryProvenance, provenanceOfMessages(dropped)),
          );
          requeued = unsummarized;
          if (flushed) {
            this.chatStore.archivePreCompact(chatId);
            this.chatStore.overwriteHistory(chatId, [summaryMsg, ...requeued, ...kept]);
          }
        } catch (err) {
          this.log.warn("Dropped message summarization failed, continuing without summary", err);
          if (previousSummary) {
            summaryMsg = makeSummaryMessage(
              previousSummary,
              previousSummaryProvenance ?? UNKNOWN_PROVENANCE,
            );
          }
        }
      } else if (previousSummary) {
        summaryMsg = makeSummaryMessage(
          previousSummary,
          previousSummaryProvenance ?? UNKNOWN_PROVENANCE,
        );
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
      const userTurnMessage = setMessageProvenance(
        { role: "user", content: userMessageWithTime },
        UNKNOWN_PROVENANCE,
      );
      let messages: ModelMessage[] = [
        ...(summaryMsg ? [summaryMsg] : []),
        ...requeued,
        ...kept,
        userTurnMessage,
      ];

      ctx.provenance.value = contextProvenance;

      let overflowAttempts = 0;
      let timeoutAttempts = 0;
      let plainTimeoutAttempts = 0;
      let rateLimitAttempts = 0;
      let serverErrorAttempts = 0;
      let classifiedTerminalFailure: ClassifiedTurnFailure | undefined;

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
          if (
            shouldCompact({
              messages,
              systemPrompt: this.systemPrompt,
              contextWindowTokens: this.config.contextWindowTokens,
            })
          ) {
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

          let attemptObservedText = false;
          classifiedTerminalFailure = undefined;
          const onAttemptTextDelta = (delta: string): void => {
            attemptObservedText = true;
            emitEvent({ type: "text_delta", turnId, delta });
          };

          try {
            turnBudget.chargeModelCall();
            ctx.provenance.value = unionProvenance(
              contextProvenance,
              provenanceOfMessages(messages),
            );
            const result = await this.llm.generate({
              system: this.systemPrompt,
              messages,
              tools: this.tools,
              stopWhen: stepCountIs(10),
              maxSteps: 10,
              caller: "chat",
              context: ctx,
              cacheKey,
              // Cap this call by the turn's remaining wall-clock budget so a retry
              // after an early timeout inherits only the time the turn has left.
              deadlineMs: turnBudget.remainingMs(),
              onTextDelta: onAttemptTextDelta,
            });
            const { text, finishReason } = result;

            // Recovery runs only on this success path (before the catch below).
            const recovered = await this.recoverStepExhaustedText(
              text,
              finishReason,
              messages,
              cacheKey,
              turnBudget,
              onAttemptTextDelta,
            );
            if (recovered.attributionBasis === "prompt") {
              ctx.provenance.value = unionProvenance(
                contextProvenance,
                provenanceOfMessages(messages),
              );
            } else if (recovered.attributionBasis === "none") {
              ctx.provenance.value = EMPTY_PROVENANCE;
            }
            let effectiveText = renderGarminAttribution(recovered.text, ctx.provenance.value);
            if (effectiveText.trim() === "") {
              effectiveText = STEP_LIMIT_TRUNCATION_MESSAGE;
              ctx.provenance.value = EMPTY_PROVENANCE;
            }

            const templateHash = (this.templateHash ??= computeTemplateHash({
              soul: this.sport.soul,
              skills: this.sport.skills,
              ruleBlocks: staticRuleBlocks(this.sport.sessionClusterGapMinutes, {
                confirmationGate: this.confirmationGate,
              }),
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
                lineageVersion: PROMPT_LINEAGE_SCHEMA_VERSION,
                provenance: ctx.provenance.value,
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
            this.ports.usage.append({
              ts: this.ports.now(),
              kind: "turn",
              caller: "chat",
              provider: this.config.llm.provider,
              model: this.config.llm.model,
              durationMs: this.ports.now() - turnStart,
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
              duration_ms: this.ports.now() - turnStart,
              compactions,
            });

            const responseText = effectiveText + persistenceNote;
            this.recordCompletedTurn({
              chatId,
              turnId,
              completedAt: new Date(this.ports.now()).toISOString(),
              athleteText: userMessage,
              coachText: responseText,
            });
            emitEvent({ type: "final-text", turnId, text: responseText });
            return responseText;
          } catch (err) {
            // The classified budget error is terminal: re-throw it before any
            // retry branch so a future reordering can never mistake it for one of
            // the retryable classes and swallow it.
            if (err instanceof TurnBudgetExceededError) throw err;
            // A committed tool write makes this turn non-replayable: retrying
            // would re-send the pre-turn messages and could re-run the write.
            const committedWrites = ctx.turnWrites;
            if (committedWrites.writesCommitted > 0) {
              const failure = classifyError(err, this.ports.classifyFailure);
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
                error_class: failure,
                overflowAttempts,
                timeoutAttempts,
                rateLimitAttempts,
                duration_ms: this.ports.now() - turnStart,
                compactions,
              });
              emitEvent(
                this.createErrorEvent({
                  failure,
                  turnId,
                  chatId,
                  overflowAttempts,
                  timeoutAttempts,
                  rateLimitAttempts,
                  durationMs: this.ports.now() - turnStart,
                  compactions,
                }),
              );
              this.recordCompletedTurn({
                chatId,
                turnId,
                completedAt: new Date(this.ports.now()).toISOString(),
                athleteText: userMessage,
                coachText: TAINTED_BY_WRITES_MESSAGE,
              });
              emitEvent({ type: "final-text", turnId, text: TAINTED_BY_WRITES_MESSAGE });
              return TAINTED_BY_WRITES_MESSAGE;
            }
            if (attemptObservedText) throw err;
            const failure = this.ports.classifyFailure(err);
            // Reactive: context overflow → flush + compact + retry
            if (failure === "overflow" && overflowAttempts < MAX_OVERFLOW_ATTEMPTS) {
              overflowAttempts++;
              try {
                if (!flushedThisTurn) {
                  flushedThisTurn = true;
                  try {
                    await this.flushMemory(messages, "overflow-recovery", turnBudget);
                  } catch (flushErr) {
                    this.log.warn(
                      "In-turn memory flush failed; compacting without flush",
                      flushErr,
                    );
                  }
                }
                messages = await summarizeInStages({
                  messages,
                  ...this.compactionParams(turnBudget),
                });
                compactions++;
                this.memory.reload();
              } catch (rescueErr) {
                this.log.warn(
                  "Compaction rescue failed; rethrowing the original turn error",
                  rescueErr,
                );
                if (err instanceof Error && err.cause === undefined) {
                  (err as Error & { cause?: unknown }).cause = rescueErr;
                }
                classifiedTerminalFailure = failure;
                throw err;
              }
              continue;
            }
            // Timeout with high context usage → compact + retry (no flush)
            if (failure === "timeout" && timeoutAttempts < MAX_TIMEOUT_ATTEMPTS) {
              const ratio = estimateMessagesTokens(messages) / this.config.contextWindowTokens;
              if (ratio > TIMEOUT_COMPACTION_THRESHOLD) {
                timeoutAttempts++;
                try {
                  messages = await summarizeInStages({
                    messages,
                    ...this.compactionParams(turnBudget),
                  });
                  compactions++;
                  this.memory.reload();
                } catch (rescueErr) {
                  this.log.warn(
                    "Compaction rescue failed; rethrowing the original turn error",
                    rescueErr,
                  );
                  if (err instanceof Error && err.cause === undefined) {
                    (err as Error & { cause?: unknown }).cause = rescueErr;
                  }
                  classifiedTerminalFailure = failure;
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
            if (failure === "rate_limit" && rateLimitAttempts < MAX_RATE_LIMIT_ATTEMPTS) {
              rateLimitAttempts++;
              const attemptNo = rateLimitAttempts;
              // The server hint (if any) is a lower bound; absent one, fall back to a
              // capped exponential. Either feeds the primitive as the Retry-After
              // floor so the 120s ceiling and the clamp note are honored bit-for-bit.
              const requestedMs =
                retryAfterFloorMs(err, this.ports.extractRetryAfterMs) ??
                Math.min(
                  RATE_LIMIT_FALLBACK_BASE_MS * RATE_LIMIT_FALLBACK_MULTIPLIER ** (attemptNo - 1),
                  RATE_LIMIT_FALLBACK_MAX_MS,
                );
              const clampNote =
                requestedMs > RATE_LIMIT_MAX_WAIT_MS
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
                  console.warn(
                    `Rate limited (attempt ${attemptNo}/${MAX_RATE_LIMIT_ATTEMPTS}), waiting ${delayMs}ms${clampNote}`,
                  );
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
            // A codex network throw is surfaced as a single attempt and tagged
            // NetworkError by the bridge's normalizeError. We deliberately cap the
            // codex network class at zero outer retries to keep it at exactly one
            // layer; the outer network retry below is for the AI-SDK path, whose
            // errors are plain TypeErrors (not name="NetworkError") and whose SDK
            // does zero retries. (Unifying codex network retry with the AI-SDK
            // path is tracked as a follow-up.)
            const alreadyRetriedNetwork =
              failure === "network" && err instanceof Error && err.name === "NetworkError";
            if (
              (failure === "server_error" || failure === "network") &&
              !alreadyRetriedNetwork &&
              serverErrorAttempts < MAX_SERVER_ERROR_ATTEMPTS
            ) {
              serverErrorAttempts++;
              const retryAfterFloor = retryAfterFloorMs(err, this.ports.extractRetryAfterMs);
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
            classifiedTerminalFailure = failure;
            throw err;
          }
        }
      } catch (terminalErr) {
        const failure =
          classifiedTerminalFailure ?? classifyError(terminalErr, this.ports.classifyFailure);
        // Single failure-emit point: every terminal throw out of the loop is one
        // failed turn, so the outcome line fires exactly once before the rethrow.
        this.emitTurnOutcome({
          turnId,
          chatId,
          ok: false,
          error_class: failure,
          overflowAttempts,
          timeoutAttempts,
          rateLimitAttempts,
          duration_ms: this.ports.now() - turnStart,
          compactions,
        });
        emitEvent(
          this.createErrorEvent({
            failure,
            turnId,
            chatId,
            overflowAttempts,
            timeoutAttempts,
            rateLimitAttempts,
            durationMs: this.ports.now() - turnStart,
            compactions,
          }),
        );
        throw terminalErr;
      }
    });
  }

  private createErrorEvent(input: {
    failure: ClassifiedTurnFailure;
    turnId: string;
    chatId: string;
    overflowAttempts: number;
    timeoutAttempts: number;
    rateLimitAttempts: number;
    durationMs: number;
    compactions: number;
  }): Extract<TurnEvent, { type: "error" }> {
    const failure = input.failure;
    const errorClass =
      failure === "budget" ||
      failure === "overflow" ||
      failure === "timeout" ||
      failure === "rate_limit"
        ? failure
        : "unknown";
    const presentation =
      failure === "rate_limit"
        ? {
            kind: "rate_limit" as const,
            athleteMessage: "Rate limited — please try again shortly.",
          }
        : failure === "reauth"
          ? {
              kind: "provider-auth" as const,
              athleteMessage:
                "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.",
            }
          : failure === "auth"
            ? {
                kind: "provider-auth" as const,
                athleteMessage:
                  "The model provider rejected the API key — check your provider credentials.",
              }
            : failure === "server_error" || failure === "network" || failure === "timeout"
              ? {
                  kind: "provider-down" as const,
                  athleteMessage:
                    "The model provider is having trouble — try again in a few minutes.",
                }
              : {
                  kind: "unknown" as const,
                  athleteMessage: "Sorry, something went wrong. Please try again.",
                };
    return {
      type: "error",
      turnId: input.turnId,
      chatId: input.chatId,
      error_class: errorClass,
      ...presentation,
      overflowAttempts: input.overflowAttempts,
      timeoutAttempts: input.timeoutAttempts,
      rateLimitAttempts: input.rateLimitAttempts,
      duration_ms: input.durationMs,
      compactions: input.compactions,
    };
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
      this.chatStore.resetConversation({
        chatId,
        boundaryAt: new Date(this.ports.now()).toISOString(),
        reason: "explicit-reset",
      });
      this.archiveDeferred.delete(chatId);
      this.lastFlushMessageCount.delete(chatId);
      return { memoryFlushed };
    });
  }

  async getAthleteState() {
    return await this.ports.stateReader.getAthleteState();
  }
}
