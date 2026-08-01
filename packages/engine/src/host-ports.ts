import type { AthleteState } from "@enduragent/coach-contract";
import type { ModelMessage } from "ai";
import type { IntervalsClient } from "intervals-icu-api";
import type { GenerateOptions, GenerateResult } from "./sport.js";
import type { LedgerEventInput } from "./sport/ledger-event.js";
import type { SourceProvenance } from "./provenance.js";

export type EngineDataSource = "platform" | "store";

export type EngineLlmProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openai-codex"
  | "claude-cli"
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
    readonly claudeCli?: {
      readonly enabled: boolean;
      readonly binaryPath?: string;
      readonly configDir?: string;
      readonly billing: "subscription" | "api-key";
      readonly cursorStorePath: string;
    };
  };
  readonly session: {
    readonly historyTokenBudgetRatio: number;
    readonly idleMinutes: number;
    readonly dailyResetHour: number;
    readonly resetArchiveRetentionDays: number;
    readonly timezone: string;
  };
  readonly contextWindowTokens: number;
  readonly compactContextWindowTokens: number;
}

export type MemoryWriteSource = "chat-tool" | "flush" | "sport-tool" | "migration" | "unattributed";

export interface MemoryStorePort {
  readMemory(): string;
  writeSection(
    section: string,
    content: string,
    source?: MemoryWriteSource,
    provenance?: SourceProvenance,
  ): void;
  readSection(section: string): string | null;
  /** Source labels for the current contents of one durable memory section. */
  provenanceForSection?(section: string, content?: string): SourceProvenance;
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
  appendDailyNote(note: string, date?: string, provenance?: SourceProvenance): void;
  readDailyNotesInRange(from: string, to: string): Array<{ date: string; text: string }>;
  readEventsRaw(): string;
  appendEvent(event: LedgerEventInput, provenance?: SourceProvenance): void;
  savePlan(plan: unknown, source?: MemoryWriteSource, provenance?: SourceProvenance): void;
  loadPlan(): unknown | null;
  /** Source labels bound to the exact visible result of a synchronous tool read. */
  provenanceForToolRead?(
    name: string,
    input: unknown,
    visibleResult?: unknown,
    opts?: { truncated?: boolean },
  ): SourceProvenance;
  reload(): void;
  getContext(opts?: { excludeSections?: readonly string[] }): string;
  /** The rendered Athlete Context together with the source labels its contents carry. */
  getContextWithProvenance?(opts?: { excludeSections?: readonly string[]; maxChars?: number }): {
    text: string;
    provenance: SourceProvenance;
  };
  /** Run `fn` with every memory write it performs attributed to `provenance`. */
  runWithWriteProvenance?<T>(provenance: SourceProvenance, fn: () => T): T;
}

export interface MemorySnapshot {
  read(sectionName: string): string | null;
  has(sectionName: string): boolean;
  listSections(): readonly string[];
  /** Source labels attached to the frozen section contents. */
  provenanceOf(sectionName: string): SourceProvenance;
}

export interface ChatLineage {
  readonly templateHash: string;
  readonly assembledHash: string;
  readonly provider: string;
  readonly model: string;
  readonly lineageVersion: string;
  readonly provenance?: SourceProvenance;
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
  resetConversation(input: ConversationResetInput): void;
  archivePreCompact(chatId: string): void;
}

export type TranscriptConversationBoundaryReason = "explicit-reset" | "stale-reset";

export interface ConversationResetInput {
  readonly chatId: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
}

export interface TranscriptCompletedTurnInput {
  readonly chatId: string;
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

export interface TranscriptWriterPort {
  appendCompletedTurn(input: TranscriptCompletedTurnInput): void;
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
      readonly error: "not_found" | "store_read_unavailable" | "invalid_snapshot" | "invalid_input";
      readonly message: string;
    };

export interface AthleteDataReaderPort {
  getAthlete(): Promise<AthleteReadResult<unknown>>;
  listWellness(input: { start: string; end?: string }): Promise<AthleteReadResult<unknown[]>>;
  listActivities(input: { start: string; end?: string }): Promise<AthleteReadResult<unknown[]>>;
  getActivity(input: { id: string }): Promise<AthleteReadResult<unknown>>;
  getStreams(input: { id: string; keys: readonly string[] }): Promise<AthleteReadResult<unknown>>;
  listCalendar(input: { start: string; end?: string }): Promise<AthleteReadResult<unknown[]>>;
  freshness(): StoredDataFreshness | undefined;
}

export interface CalendarEventForDelete {
  readonly id: number;
  readonly startDateLocal: string;
  readonly name?: string | null;
  readonly category?: string | null;
  readonly tags?: string[] | null;
  readonly externalId?: string | null;
}

export interface PlatformCalendarMutationsPort {
  createEvent(input: unknown): Promise<unknown>;
  readEventForDelete(input: { eventId: number }): Promise<CalendarEventForDelete>;
  deleteEvent(input: { eventId: number }): Promise<unknown>;
}

export interface ToolConfirmationPort {
  /** Tools this host gates. The engine registers the confirmation prompt block iff this set is non-empty. */
  readonly gatedToolNames: ReadonlySet<string>;
  /**
   * Record a proposal and return the value the model sees. MUST NOT invoke `run`;
   * `run` executes only when the host's own confirm surface resolves the proposal.
   */
  propose(input: {
    readonly chatId: string;
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly run: () => Promise<unknown>;
  }): Promise<unknown>;
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
  readonly providerReportedCostUsd?: number;
  readonly cost?: UsageCost;
  readonly stopReason?: string;
}

export interface UsagePort {
  append(line: UsageLedgerLine): void;
}

export type FailureReason =
  | "overflow"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "network"
  | "auth"
  | "reauth"
  | "invalid_request"
  | "unknown";

export interface ModelTransportRequest {
  readonly provider: EngineLlmProvider;
  readonly model: string;
  readonly options: GenerateOptions;
}

export interface ModelTransport {
  generate(request: ModelTransportRequest): Promise<GenerateResult>;
}

export type ModelTransportDecorator = (next: ModelTransport) => ModelTransport;

export interface ChatStreamTimeouts {
  readonly ttftMs: number;
  readonly interChunkMs: number;
}

export interface AthleteStateReaderPort {
  getAthleteState(): Promise<AthleteState>;
}

export interface ReferenceStateSnapshot {
  readonly errorState: {
    readonly mitigation?: string;
    readonly ts: string;
  } | null;
  readonly latest: {
    readonly metadata?: { readonly last_updated?: string };
  } | null;
}

export interface EngineHostPorts {
  readonly config: EngineConfig;
  readonly memory: MemoryStorePort;
  readonly chatStore: ChatStorePort;
  readonly transcriptWriter: TranscriptWriterPort;
  readonly secrets: SecretsPort;
  readonly platform: PlatformClientPort;
  readonly logger: LoggerPort;
  readonly usage: UsagePort;
  readonly stateReader: AthleteStateReaderPort;
  readonly readReferenceState: () => ReferenceStateSnapshot;
  readonly getAccessToken: (profileName: string, signal?: AbortSignal) => Promise<string>;
  readonly classifyFailure: (error: unknown) => FailureReason;
  readonly extractRetryAfterMs: (error: unknown) => number | null;
  readonly now: () => number;
  readonly randomId: () => string;
  readonly chatStreamTimeouts?: ChatStreamTimeouts;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
  readonly toolConfirmations?: ToolConfirmationPort;
}
