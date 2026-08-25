import type {
  ChatQueueRunResult,
  ChatQueueSnapshot,
  CoachEngine,
  QueuedChatMessage,
  TurnEvent,
} from "@enduragent/coach-contract";
import { CoachAgent } from "./agent/coach-agent.js";
import { extractAccountId } from "./agent/codex/jwt.js";
import type { EngineHostPorts } from "./host-ports.js";
import type { Sport } from "./sport.js";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import type { SourceProvenance } from "./provenance.js";

export type { CoachEngine } from "@enduragent/coach-contract";
export type { ChatStreamTimeouts } from "./host-ports.js";
export type {
  AthleteDataReaderPort,
  AthleteReadResult,
  AthleteStateReaderPort,
  CalendarEventForDelete,
  CallerRole,
  ChatLineage,
  ChatStorePort,
  CoachDecisionStorePort,
  ConversationResetInput,
  EngineConfig,
  EngineDataSource,
  EngineHostPorts,
  EngineLlmProvider,
  EnvSecretRef,
  ExecSecretRef,
  FailureReason,
  LoggerFields,
  LoggerPort,
  MemorySnapshot,
  MemoryStorePort,
  MemoryWriteSource,
  ModelTransport,
  ModelTransportDecorator,
  ModelTransportRequest,
  PlatformCalendarMutationsPort,
  PlatformClientPort,
  PlanPersistencePort,
  ReferenceStateSnapshot,
  SecretRef,
  SecretsPort,
  StoredDataFreshness,
  ToolConfirmationPort,
  TranscriptCompletedTurnInput,
  TranscriptConversationBoundaryReason,
  TranscriptInterruptedTurnInput,
  TranscriptWriterPort,
  UsageCost,
  UsageCostBasis,
  UsageLedgerLine,
  UsagePort,
} from "./host-ports.js";

export interface CreateCoachEngineInput {
  readonly sport: Sport;
  readonly ports: EngineHostPorts;
}

export function createCoachEngine(input: CreateCoachEngineInput): CoachEngine {
  const agent = new CoachAgent(input.sport, input.ports);
  const queueRuns = new Map<string, Promise<ChatQueueRunResult>>();
  const queueAuthorities = new Map<string, Promise<void>>();
  const withQueueAuthority = async <T>(chatId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queueAuthorities.get(chatId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    queueAuthorities.set(chatId, tail);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (queueAuthorities.get(chatId) === tail) queueAuthorities.delete(chatId);
    }
  };
  const queuePort = <K extends keyof EngineHostPorts["chatStore"]>(
    name: K,
  ): NonNullable<EngineHostPorts["chatStore"][K]> => {
    const operation = input.ports.chatStore[name];
    if (typeof operation !== "function")
      throw new Error("Durable chat queue storage is unavailable.");
    return operation as NonNullable<EngineHostPorts["chatStore"][K]>;
  };
  const snapshot = (chatId: string): ChatQueueSnapshot =>
    queuePort("getChatQueue").call(input.ports.chatStore, chatId);
  const queueText = (items: readonly QueuedChatMessage[]): string =>
    items.map((item) => item.text).join("\n\n");
  const runQueue = (
    chatId: string,
    mode: "resume" | "command" | "retry",
    exactId: string | undefined,
    onEvent: ((event: TurnEvent) => void) | undefined,
  ): Promise<ChatQueueRunResult> => {
    const active = queueRuns.get(chatId);
    if (active !== undefined) return active;
    const task = withQueueAuthority(chatId, async (): Promise<ChatQueueRunResult> => {
      const before = snapshot(chatId);
      const pendingDecision = input.ports.coachDecisions?.getDecision(chatId);
      if (
        pendingDecision?.status === "unanswered" ||
        (pendingDecision?.status === "answered" &&
          pendingDecision.continuation.status === "pending")
      ) {
        return { snapshot: before };
      }
      let claimId: string;
      let turnId: string;
      let selected: readonly QueuedChatMessage[];
      if (mode === "retry") {
        const recovery = before.retryRequired;
        if (recovery === undefined || recovery.claimId !== exactId) return { snapshot: before };
        claimId = recovery.claimId;
        turnId = input.ports.randomId();
        selected = before.items.slice(0, recovery.queuedMessageIds.length);
        queuePort("retryChatQueueClaim").call(input.ports.chatStore, chatId, claimId, turnId);
      } else {
        const head = before.items[0];
        if (head === undefined || before.retryRequired !== undefined) return { snapshot: before };
        if (mode === "command") {
          if (head.kind !== "slash-command" || head.queuedMessageId !== exactId)
            return { snapshot: before };
          selected = [head];
        } else {
          if (head.kind === "slash-command") {
            if (head.restored) return { snapshot: before };
            selected = [head];
          } else {
            let size = 1;
            while (before.items[size]?.kind === "ordinary") size += 1;
            selected = before.items.slice(0, size);
          }
        }
        claimId = input.ports.randomId();
        turnId = input.ports.randomId();
        queuePort("claimChatQueue").call(
          input.ports.chatStore,
          chatId,
          claimId,
          turnId,
          selected.map((item) => item.queuedMessageId),
        );
      }
      let interrupted = false;
      try {
        let decision;
        const text = await agent.chat(
          chatId,
          queueText(selected),
          undefined,
          (event) => {
            if (event.type === "interrupted") interrupted = true;
            onEvent?.(event);
          },
          (requested) => {
            decision = requested;
          },
          turnId,
        );
        if (interrupted) {
          return {
            snapshot: queuePort("requireChatQueueRetry").call(
              input.ports.chatStore,
              chatId,
              claimId,
            ),
            response: decision === undefined ? { text } : { text, decision },
          };
        }
        return {
          snapshot: queuePort("completeChatQueueClaim").call(
            input.ports.chatStore,
            chatId,
            claimId,
          ),
          response: decision === undefined ? { text } : { text, decision },
        };
      } catch (error) {
        queuePort("requireChatQueueRetry").call(input.ports.chatStore, chatId, claimId);
        throw error;
      }
    });
    queueRuns.set(chatId, task);
    const release = (): void => {
      if (queueRuns.get(chatId) === task) queueRuns.delete(chatId);
    };
    void task.then(release, release);
    return task;
  };
  return {
    chat: async (request, onEvent) => {
      let decision;
      const text = await agent.chat(
        request.chatId,
        request.message,
        request.turn as
          | { resolvedCs?: ResolvedCs | null; referenceProvenance?: SourceProvenance }
          | undefined,
        onEvent,
        (requested) => {
          decision = requested;
        },
      );
      return decision === undefined ? { text } : { text, decision };
    },
    stopChat: async (request) => ({ stopped: agent.stopChat(request.chatId, request.turnId) }),
    enqueueChatMessage: async (request) =>
      queuePort("enqueueChatMessage").call(
        input.ports.chatStore,
        request.chatId,
        request.submissionId,
        request.text,
        input.ports.randomId(),
        input.ports.randomId(),
        request.attachmentIds,
      ),
    getChatQueue: async (request) => snapshot(request.chatId),
    removeQueuedChatMessage: async (request) =>
      queuePort("removeQueuedChatMessage").call(
        input.ports.chatStore,
        request.chatId,
        request.queuedMessageId,
      ),
    resumeChatQueue: (request, onEvent) => runQueue(request.chatId, "resume", undefined, onEvent),
    runQueuedCommand: (request, onEvent) =>
      runQueue(request.chatId, "command", request.queuedMessageId, onEvent),
    retryQueuedTurn: (request, onEvent) =>
      runQueue(request.chatId, "retry", request.claimId, onEvent),
    getCoachDecision: (request) => agent.getCoachDecision(request),
    answerCoachDecision: (request, onEvent) => agent.answerCoachDecision(request, onEvent),
    skipCoachDecision: (request) => agent.skipCoachDecision(request),
    resumeCoachDecision: (request, onEvent) => agent.resumeCoachDecision(request, onEvent),
    resetSession: (request) =>
      withQueueAuthority(request.chatId, () => agent.resetSession(request.chatId)),
    hasSession: async (request) => ({ hasSession: agent.hasSession(request.chatId) }),
    getAthleteState: () => agent.getAthleteState(),
  };
}

export { extractAccountId };
export { makeSummaryMessage, splitHistoryByBudget, SUMMARY_PREFIX } from "./agent/history-limit.js";
export { truncateUtf16Safe } from "./text-truncate.js";
export { warnOrphanSections, _resetOrphanWarnCacheForTesting } from "./sport/orphan-sections.js";
export { capToolResult, TOOL_RESULT_SHARE } from "./agent/tool-result-cap.js";
export {
  COMPACTION_SUMMARY_MARKER,
  demoteSummaryHeadings,
  formatCompactionNote,
  persistCompactionSummary,
} from "./agent/compaction-note.js";
export {
  bindToolResult,
  boundToolResultProvenance,
  carryBoundToolResultProvenance,
  unwrapBoundToolResult,
} from "./sport/bound-tool-result.js";
export {
  DATE_KEY_RE,
  INTERVALS_LIST_MAX_RANGE_DAYS,
  dateKeySchema,
  validateListRange,
  validateWorkoutCreationDate,
} from "./sport/date-schema.js";
export { GARMIN_DATA_ATTRIBUTION, renderGarminAttribution } from "./agent/garmin-attribution.js";
export {
  ATHLETE_CONTEXT_FENCE_CLOSE,
  ATHLETE_CONTEXT_FENCE_OPEN,
  ATHLETE_CONTEXT_TRUNCATION_NOTICE,
  FENCE_TOKEN_REPLACEMENT,
  isUntrustedEnvelope,
  markUntrustedResult,
  sanitizeUntrustedText,
  wrapAthleteContextFence,
} from "./agent/prompt-fence.js";
export {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  classifyActivities,
  classifyActivity,
  classifyTrustedSource,
  contentDigest,
  getMessageProvenance,
  isNonEmptyData,
  isSourceProvenance,
  provenanceForSourceBearingData,
  provenanceOfMessages,
  setMessageProvenance,
  unionProvenance,
  type SourceProvenance,
} from "./provenance.js";
export {
  isProviderAuthFailure,
  markProviderAuthFailure,
  type ProviderAuthFailure,
} from "./provider-auth-failure.js";
export {
  cacheReadSavingsUsd,
  classifySpendCaching,
  priceInclusiveUsage,
  type UsageTokenCounts,
} from "./usage-cost.js";
export {
  CLAUDE_CLI_PRICE_TABLE,
  claudeCliCacheReadSavingsUsd,
  priceClaudeCliInclusiveUsage,
  resolveClaudeCliPriceId,
} from "./agent/claude-cli/cost.js";
export {
  ClaudeCliConfigError,
  ClaudeWorkingAreaError,
  type ClaudeCliConfigErrorKind,
  type ClaudeWorkingAreaFailureCategory,
  type ClaudeWorkingAreaStage,
} from "./agent/claude-cli/errors.js";
export {
  createClaudeWorkingArea,
  type ClaudeLaunchPurpose,
  type ClaudeWorkingAreaBinding,
  type ClaudeWorkingAreaPort,
  type CreateClaudeWorkingAreaInput,
} from "./agent/claude-cli/working-area.js";
export {
  CODEX_AGENT_PRICE_TABLE,
  codexAgentCacheReadSavingsUsd,
  priceCodexAgentInclusiveUsage,
  resolveCodexAgentPriceId,
} from "./agent/codex-agent/cost.js";
export {
  CodexAgentConfigError,
  type CodexAgentConfigErrorKind,
} from "./agent/codex-agent/errors.js";
export {
  codexIdentityLine,
  ensureCodexAgentReady,
  invalidateCodexAgentProbeCache,
  type CodexAgentReadinessRefusal,
  type CodexAgentReadinessReport,
  type CodexAgentReadinessResult,
  type EnsureCodexAgentReadyDeps,
  type EnsureCodexAgentReadyInput,
} from "./agent/codex-agent/probe.js";
export {
  API_KEY_BILLING_IDENTITY_LINE,
  claudeIdentityLine,
  ensureClaudeCliReady,
  invalidateClaudeAccountProbeCache,
  probeClaudeAccountCached,
  recheckClaudeAccount,
  type CachedProbeDeps,
  type ClaudeAccountClass,
  type ClaudeAccountProbeFailure,
  type ClaudeAccountProbeResult,
  type ClaudeCliReadiness,
  type EnsureClaudeCliReadyDeps,
  type EnsureClaudeCliReadyInput,
  type ProbeClaudeAccountDeps,
  type ProbeClaudeAccountInput,
} from "./agent/claude-cli/probe.js";
