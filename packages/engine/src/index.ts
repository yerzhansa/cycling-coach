import type { CoachEngine } from "@enduragent/coach-contract";
import { CoachAgent } from "./agent/coach-agent.js";
import { extractAccountId } from "./agent/codex/jwt.js";
import type { EngineHostPorts } from "./host-ports.js";
import type { Sport } from "./sport.js";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";

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
        request.turn as { resolvedCs?: ResolvedCs | null } | undefined,
        onEvent,
      ),
    }),
    resetSession: (request) => agent.resetSession(request.chatId),
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
  cacheReadSavingsUsd,
  classifySpendCaching,
  priceInclusiveUsage,
  type UsageTokenCounts,
} from "./usage-cost.js";
