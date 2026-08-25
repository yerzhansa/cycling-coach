import type { CoachEngine } from "@enduragent/coach-contract";
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
  CalendarEventUpdate,
  CallerRole,
  ChatLineage,
  ChatStorePort,
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
  ReferenceStateSnapshot,
  SecretRef,
  SecretsPort,
  StoredDataFreshness,
  ToolConfirmationPort,
  TranscriptCompletedTurnInput,
  TranscriptConversationBoundaryReason,
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
  return {
    chat: async (request, onEvent) => ({
      text: await agent.chat(
        request.chatId,
        request.message,
        request.turn as
          | { resolvedCs?: ResolvedCs | null; referenceProvenance?: SourceProvenance }
          | undefined,
        onEvent,
      ),
    }),
    resetSession: (request) => agent.resetSession(request.chatId),
    hasSession: async (request) => ({ hasSession: agent.hasSession(request.chatId) }),
    getAthleteState: () => agent.getAthleteState(),
  };
}

export { extractAccountId };
export {
  PLAN_MIRROR_DAYS,
  PLAN_MIRROR_EXTERNAL_ID_PREFIX,
  cleanupPlanMirror,
  planMirrorExternalId,
  planMirrorExternalIdPrefix,
  projectPlanReconciliation,
  reconcileActivePlanWindow,
  type PlanMirrorCalendarPort,
  type PlanMirrorCreateInput,
  type PlanMirrorEvent,
  type PlanReconciliationDomainState,
  type PlanReconciliationProjection,
  type PlanReconcilerDeps,
  type PlanReconcilerIdentity,
} from "./planning/reconciler.js";
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
