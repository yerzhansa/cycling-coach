import type { CoachEngine } from "@enduragent/coach-contract";
import { CoachAgent } from "./agent/coach-agent.js";
import { extractAccountId } from "./agent/codex/jwt.js";
import type { EngineHostPorts } from "./host-ports.js";
import type { Sport } from "./sport.js";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";

export type { CoachEngine } from "@enduragent/coach-contract";
export type {
  AthleteDataReaderPort,
  AthleteReadResult,
  AthleteStateReaderPort,
  CalendarEventForDelete,
  CallerRole,
  ChatLineage,
  ChatStorePort,
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
    chat: async (request) => ({
      text: await agent.chat(
        request.chatId,
        request.message,
        request.turn as { resolvedCs?: ResolvedCs | null } | undefined,
      ),
    }),
    resetSession: (request) => agent.resetSession(request.chatId),
    hasSession: async (request) => ({ hasSession: agent.hasSession(request.chatId) }),
    getAthleteState: () => agent.getAthleteState(),
  };
}

export { extractAccountId };
