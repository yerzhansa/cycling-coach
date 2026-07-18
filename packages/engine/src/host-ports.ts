import type { AthleteState } from "@enduragent/coach-contract";
import type { ModelMessage } from "ai";
import type { IntervalsClient } from "intervals-icu-api";

export type EngineDataSource = "platform" | "store";

export type EngineLlmProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openai-codex"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "kimi"
  | "zai"
  | "openrouter";

export interface EngineConfig {
  readonly dataSource: EngineDataSource;
  readonly llm: {
    readonly provider: EngineLlmProvider;
    readonly model: string;
    readonly apiKey: string;
    readonly authProfile?: string;
    readonly flushModel?: string;
    readonly compactModel?: string;
    readonly baseUrl?: string;
  };
  readonly session: {
    readonly historyTokenBudgetRatio: number;
    readonly idleMinutes: number;
    readonly dailyResetHour: number;
    readonly timezone: string;
  };
  readonly contextWindowTokens: number;
}

export type MemoryWriteSource =
  | "chat-tool"
  | "flush"
  | "sport-tool"
  | "migration"
  | "unattributed";

export type LedgerEventKind =
  | "decision"
  | "override"
  | "illness"
  | "experiment"
  | "outcome";

export interface LedgerEventInput {
  readonly date: string;
  readonly kind: LedgerEventKind;
  readonly text: string;
  readonly source: "flush";
}

export interface MemoryStorePort {
  readMemory(): string;
  writeSection(section: string, content: string, source?: MemoryWriteSource): void;
  readSection(section: string): string | null;
  renameSection(
    from: string,
    to: string,
    source?: MemoryWriteSource,
  ): "renamed" | "noop" | "merged";
  renameSections(
    renames: ReadonlyArray<readonly [string, string]>,
    source?: MemoryWriteSource,
  ): Array<"renamed" | "noop" | "merged">;
  readDailyNotes(date?: string): string;
  appendDailyNote(note: string, date?: string): void;
  readDailyNotesInRange(from: string, to: string): Array<{ date: string; text: string }>;
  readEventsRaw(): string;
  appendEvent(event: LedgerEventInput): void;
  savePlan(plan: unknown, source?: MemoryWriteSource): void;
  loadPlan(): unknown | null;
  reload(): void;
  getContext(): string;
}

export interface MemorySnapshot {
  read(sectionName: string): string | null;
  has(sectionName: string): boolean;
  listSections(): readonly string[];
}

export interface ChatLineage {
  readonly templateHash: string;
  readonly assembledHash: string;
  readonly provider: string;
  readonly model: string;
}

export interface ChatStorePort {
  hasSession(chatId: string): boolean;
  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null };
  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: ChatLineage,
  ): void;
  overwriteHistory(chatId: string, messages: ModelMessage[]): void;
  archiveAndReset(chatId: string): void;
  archivePreCompact(chatId: string): void;
}

export type ExecSecretRef = {
  readonly source: "exec";
  readonly command: string;
  readonly args?: string[];
};

export type EnvSecretRef = {
  readonly source: "env";
  readonly var: string;
};

export type SecretRef = ExecSecretRef | EnvSecretRef;

export interface SecretsPort {
  resolve(ref: SecretRef): Promise<string>;
}

export interface StoredDataFreshness {
  readonly capturedAt: string;
  readonly ageMs: number;
  readonly label: string;
}

export type AthleteReadResult<T> =
  | { readonly ok: true; readonly value: T; readonly freshness?: StoredDataFreshness }
  | {
      readonly ok: false;
      readonly error:
        | "not_found"
        | "store_read_unavailable"
        | "invalid_snapshot"
        | "invalid_input";
      readonly message: string;
    };

export interface AthleteDataReaderPort {
  getAthlete(): Promise<AthleteReadResult<unknown>>;
  listWellness(input: {
    start: string;
    end?: string;
  }): Promise<AthleteReadResult<unknown[]>>;
  listActivities(input: {
    start: string;
    end?: string;
  }): Promise<AthleteReadResult<unknown[]>>;
  getActivity(input: { id: string }): Promise<AthleteReadResult<unknown>>;
  getStreams(input: {
    id: string;
    keys: readonly string[];
  }): Promise<AthleteReadResult<unknown>>;
  listCalendar(input: {
    start: string;
    end?: string;
  }): Promise<AthleteReadResult<unknown[]>>;
  freshness(): StoredDataFreshness | undefined;
}

export interface CalendarEventForDelete {
  readonly id: number;
  readonly startDateLocal: string;
}

export interface PlatformCalendarMutationsPort {
  createEvent(input: unknown): Promise<unknown>;
  readEventForDelete(input: { eventId: number }): Promise<CalendarEventForDelete>;
  deleteEvent(input: { eventId: number }): Promise<unknown>;
}

export interface PlatformClientPort {
  readonly legacyClient: IntervalsClient | null;
  readonly athleteData: AthleteDataReaderPort | undefined;
  readonly calendarMutations: PlatformCalendarMutationsPort;
}

export type LoggerFields = Record<string, unknown>;

export interface LoggerPort {
  debug(event: string, fields?: LoggerFields): void;
  info(event: string, fields?: LoggerFields): void;
  warn(event: string, error?: unknown, fields?: LoggerFields): void;
  error(event: string, error?: unknown, fields?: LoggerFields): void;
}

export type CallerRole = "chat" | "flush" | "compact" | "sync-triage" | "dream";

export interface UsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface UsageLedgerLine {
  readonly ts: number;
  readonly kind: "generate" | "turn" | "boot";
  readonly provider: string;
  readonly model: string;
  readonly durationMs: number;
  readonly caller?: CallerRole;
  readonly templateHash?: string;
  readonly steps?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cost?: UsageCost;
  readonly stopReason?: string;
}

export interface UsagePort {
  append(line: UsageLedgerLine): void;
}

export interface AthleteStateReaderPort {
  getAthleteState(): Promise<AthleteState>;
}

export interface EngineHostPorts {
  readonly config: EngineConfig;
  readonly memory: MemoryStorePort;
  readonly chatStore: ChatStorePort;
  readonly secrets: SecretsPort;
  readonly platform: PlatformClientPort;
  readonly logger: LoggerPort;
  readonly usage: UsagePort;
  readonly stateReader: AthleteStateReaderPort;
}
