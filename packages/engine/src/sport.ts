import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import type {
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  StopCondition,
  Tool,
  ToolSet,
} from "ai";
import type { Activity, IntervalsClient } from "intervals-icu-api";
import type { z } from "zod";
import type {
  AthleteDataReaderPort,
  AthleteReadResult,
  CallerRole,
  CalendarEventForDelete,
  EnvSecretRef,
  ExecSecretRef,
  MemorySnapshot,
  MemoryStorePort,
  MemoryWriteSource,
  PlatformCalendarMutationsPort,
  SecretRef,
  SecretsPort,
  StoredDataFreshness,
  UsageCost,
} from "./host-ports.js";

export type {
  AthleteDataReaderPort,
  AthleteReadResult,
  CallerRole,
  CalendarEventForDelete,
  EnvSecretRef,
  ExecSecretRef,
  MemorySnapshot,
  MemoryStorePort,
  MemoryWriteSource,
  PlatformCalendarMutationsPort,
  SecretRef,
  SecretsPort,
  StoredDataFreshness,
} from "./host-ports.js";
export type {
  LedgerEventInput,
  LedgerEventKind,
  LedgerEventSource,
} from "./sport/ledger-event.js";
export {
  LEDGER_DATE_PATTERN,
  LEDGER_EVENT_KINDS,
  LEDGER_EVENT_SOURCES,
} from "./sport/ledger-event.js";

export type SportId = "cycling" | "running" | "duathlon" | "swimming" | "triathlon";

export type IntervalsActivityType =
  | "Ride"
  | "Run"
  | "VirtualRide"
  | "TrailRun"
  | "MountainBikeRide"
  | "GravelRide"
  | "EBikeRide"
  | "Swim"
  | "OpenWaterSwim"
  | "VirtualRun";

export interface Person {
  weight: number;
  age: number;
  availableDays: number;
}

export interface MemorySectionSpec {
  name: string;
  description: string;
  schema?: z.ZodTypeAny;
}

export interface ToolRegistration {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  tool: Tool;
}

export interface GenerateOptions {
  system?: string;
  messages?: ModelMessage[];
  prompt?: string;
  tools?: ToolSet;
  stopWhen?: StopCondition<any> | Array<StopCondition<any>>;
  maxSteps?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  cacheKey?: string;
  caller?: CallerRole;
  context?: unknown;
  onTextDelta?: (delta: string) => void;
  onStreamActivity?: (activity: ModelStreamActivity) => void;
}

export type ModelStreamActivity =
  | { readonly type: "activity" }
  | { readonly type: "tool_start"; readonly toolCallId: string }
  | { readonly type: "tool_end"; readonly toolCallId: string };

export interface GenerateResult {
  text: string;
  toolCalls: Array<{
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  totalUsage?: LanguageModelUsage;
  steps?: number;
  cost?: UsageCost;
}

export interface LanguageModelPort {
  generate(options: GenerateOptions): Promise<GenerateResult>;
}

export interface SportRuntimePorts {
  llm: LanguageModelPort;
  intervals: IntervalsClient | null;
  athleteData?: AthleteDataReaderPort;
  calendarMutations?: PlatformCalendarMutationsPort;
  memory: MemoryStorePort;
  secrets: SecretsPort;
  tz: string;
  resolvedCs?: (options: unknown) => ResolvedCs | null;
}

export type CoreDeps = SportRuntimePorts;

export interface DfaSummary {
  readonly sufficient: boolean;
  readonly value?: number;
}

export interface PowerCurveDeltaSummary {
  readonly anchorsCovered: number;
  readonly trend?: "up" | "down" | "flat";
}

export interface ReferenceSportAdapter {
  readonly activityTypes: readonly IntervalsActivityType[];
  readonly zoneBasis: "power" | "pace" | "hr";
  readonly decouplingBasis: "power" | "pace";
  readonly sustainabilityAnchors: readonly number[];
  readonly dfaValidated: boolean;
  readonly anchorType: "critical-speed" | "ftp";
  computeDfa?(activity: Activity): DfaSummary | null;
  computePowerCurve?(activities: readonly Activity[]): PowerCurveDeltaSummary | null;
}

export interface Sport {
  readonly id: SportId;
  readonly soul: string;
  readonly skills: Readonly<Record<string, string>>;
  readonly sessionClusterGapMinutes: number;
  readonly memorySections: readonly MemorySectionSpec[];
  readonly mustPreserveTokens:
    | readonly string[]
    | ((memory: MemorySnapshot) => readonly string[]);
  readonly intervalsActivityTypes: readonly IntervalsActivityType[];
  readonly athleteProfileSchema: z.ZodTypeAny;
  tools(ports: SportRuntimePorts): readonly ToolRegistration[];
  referenceAdapters?(): readonly ReferenceSportAdapter[];
}

export type SportPersona = Pick<Sport, "soul" | "skills" | "sessionClusterGapMinutes">;

export type SportMemoryShape = Pick<Sport, "memorySections" | "mustPreserveTokens">;

export function mergeSportSkills(
  ...records: ReadonlyArray<Readonly<Record<string, string>>>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (key in merged) {
        throw new Error(
          `Duplicate skill key "${key}" while composing sports. ` +
            `Skill keys must be sport-prefixed (e.g. "cycling-${key}") to compose.`,
        );
      }
      merged[key] = value;
    }
  }
  return merged;
}

export { MS_PER_DAY, eachDateKeyInRange, isRealDateKey, parseDateKeyMs } from "./sport/date-keys.js";
export { getEffectiveSections } from "./sport/effective-sections.js";
export { createMemorySnapshot } from "./sport/memory-snapshot.js";
export { messageText } from "./sport/model-message.js";
export {
  createMemoryQueryTool,
  createMemoryReadTool,
  createMemoryTools,
} from "./sport/memory-tools.js";
export {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "./sport/platform-tools.js";
export { todayInTZ } from "./sport/user-time.js";
