import type { CoachEngine } from "@enduragent/coach-contract";
import type { EngineHostPorts } from "./host-ports.js";
import type { Sport } from "./sport.js";

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
  LedgerEventInput,
  LedgerEventKind,
  LoggerFields,
  LoggerPort,
  MemorySnapshot,
  MemoryStorePort,
  MemoryWriteSource,
  PlatformCalendarMutationsPort,
  PlatformClientPort,
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

export type CoachEngineFactory = (input: CreateCoachEngineInput) => CoachEngine;
