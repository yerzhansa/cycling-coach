// ─── Binary deployment shell ──────────────────────────────────────────
export type { BinaryConfig } from "./binary.js";
export { getCoachHome } from "./coach-home.js";

// ─── Setup wizard ─────────────────────────────────────────────────────
export { runSetup } from "./setup.js";

// ─── Binary entry point ───────────────────────────────────────────────
export { runBinary } from "./run-binary.js";
export type { PreparedCoachComposition, RunBinaryHooks } from "./run-binary.js";
export { reportFatal } from "./process-guard.js";

// ─── Sport contract ───────────────────────────────────────────────────
export type {
  CoreDeps,
  IntervalsActivityType,
  MemorySectionSpec,
  Sport,
  SportId,
  SportMemoryShape,
  SportPersona,
  ToolRegistration,
} from "./sport.js";
export {
  createCoreToolsWithSportConfig,
  createMemoryQueryTool,
  createMemoryReadTool,
  createMemorySnapshot,
  createMemoryTools,
  createPureCoreIntervalsTools,
  getEffectiveSections,
  mergeSportSkills,
} from "./sport.js";

// ─── Reference layer (see NOTICE.md for upstream attribution) ────────
// Per-sport seam types, freshness/timing constants, path resolver, I/O
// helpers, strict Zod cache schemas with per-file SCHEMA_VERSION
// constants, REFERENCE_PRESERVE_TOKENS, and downstream submodules
// (sync, metrics, validation, curator, units, audit) as they come online.
export * from "./reference/index.js";
export { bootstrapReference } from "./reference/runtime.js";
export type { BootstrapReferenceDeps, ReferenceRuntime } from "./reference/runtime.js";
export { wrapFetchWithSignal } from "./reference/sync/intervals-client-factory.js";
export { makeChatClient } from "./reference/sync/intervals-client-factory.js";

export {
  appendUsageLine,
  readUsageLedger,
  USAGE_LEDGER_FILE,
  USAGE_LEDGER_MAX_BYTES,
  type UsageLedgerReadResult,
} from "./usage-ledger.js";
export { atomicWriteJson } from "./io/atomic-write-json.js";

// ─── Logging substrate ────────────────────────────────────────────────
export {
  createSubsystemLogger,
  createSubsystemLoggers,
  redactObject,
  REDACTION_SENTINEL,
  serializeError,
  LOG_LEVELS,
  normalizeLogLevel,
} from "./logging/index.js";
export type { LogLine, LogLevel, SubsystemLogger, Subsystem } from "./logging/index.js";

// ─── Memory ───────────────────────────────────────────────────────────
export type { MemorySnapshot, MemoryStore, MemoryWriteSource } from "./memory.js";
export { Memory } from "./memory/store.js";
export type { MemoryJournalEntry } from "./memory/journal.js";

// ─── Secrets ──────────────────────────────────────────────────────────
export type { EnvSecretRef, ExecSecretRef, SecretRef, SecretsResolver } from "./secrets/types.js";
export { SecretResolutionError, isSecretRef } from "./secrets/types.js";
export { resolveSecretRef, _resolveSecretRefWithOverrides } from "./secrets/resolve.js";
export {
  detectBackends,
  _detectBackendsWithOverrides,
  findInPath,
} from "./secrets/backends/detect.js";
export type { BackendAvailability, KeychainState, OpState } from "./secrets/backends/detect.js";
export {
  KeychainUnsafeValueError,
  KeychainUnsupportedPlatformError,
  assertKeychainSafeValue,
  keychainItemDelete,
  keychainItemExists,
  keychainItemUpsert,
  keychainLoginPath,
  keychainSecretRef,
} from "./secrets/backends/keychain.js";
export type { KeychainOverrides } from "./secrets/backends/keychain.js";
export {
  OpVaultAmbiguousError,
  SecretTooLargeError,
  opItemCreate,
  opItemDelete,
  opItemGet,
  opItemUpdate,
  opSecretRef,
  opVaultList,
  redactTemplateForLog,
} from "./secrets/backends/op.js";

// ─── Intervals ────────────────────────────────────────────────────────
export type { IntervalsClient } from "./intervals.js";

// ─── Agent ────────────────────────────────────────────────────────────
export { CoachAgent } from "./agent/coach-agent.js";
export { createCoachEngine } from "./agent/coach-engine.js";
export type {
  CoachEngineSeam,
  LegacyEngineOverrides,
  LocalCoachEngine,
} from "./agent/coach-engine.js";
export { ChatStore } from "./agent/chat-store.js";
export { engineConfigFromConfig } from "./agent/engine-host-adapter.js";
export { classifyFailure, extractRetryAfterMs } from "./agent/token-utils.js";

// ─── Auth ─────────────────────────────────────────────────────────────
export {
  RefreshTokenReusedError,
  getFreshToken,
  loadProfile,
  saveProfile,
} from "./auth/profiles.js";
export type { OAuthCredential } from "./auth/profiles.js";
export {
  compareAndSaveStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  saveStoredProfile,
} from "./auth/profile-store.js";
export type {
  CompareAndSaveStoredProfileResult,
  StoredProfile,
  StoredProfileSnapshot,
} from "./auth/profile-store.js";
export { TokenRefreshError } from "./auth/refresh-failure.js";
export type { RefreshFailure, RefreshFailureReason } from "./auth/refresh-failure.js";
export { runCodexLogin } from "./auth/openai-codex-login.js";
export { loginCodex, refreshCodexToken } from "./agent/codex/oauth.js";
export type { CodexCredentials, CodexLoginOptions } from "./agent/codex/oauth.js";

// ─── Channels ─────────────────────────────────────────────────────────
export { createTelegramBot, notifyUpdate } from "./channels/telegram.js";

// ─── Config ───────────────────────────────────────────────────────────
export {
  CONFIG_DIR,
  CONFIG_FILE,
  loadConfig,
  loadConfigFromYaml,
  readConfigYaml,
  resolveConfigSecrets,
} from "./config.js";
export type { Config, LoadConfigOptions } from "./config.js";
export { DATA_SOURCES, resolveDataSource } from "./config.js";
export type { DataSource } from "./config.js";
export {
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  contextWindowForModel,
  resolveLlmProvider,
  resolveRuntimeConfig,
} from "./runtime-config.js";
export type {
  EffectiveRuntimeConfig,
  LlmProvider,
  RuntimeConfigPatch,
  RuntimeConfigResolverOptions,
} from "./runtime-config.js";
export {
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
  createMissingPlatformCalendarMutations,
  createStoreAthleteDataReader,
  formatStoreFreshness,
  isRealCivilDate,
  PlatformApiError,
  PlatformCredentialsRequiredError,
} from "./athlete-data.js";
export type {
  AthleteDataReader,
  AthleteReadResult,
  CalendarEventForDelete,
  PlatformCalendarMutations,
  StoredDataFreshness,
} from "./athlete-data.js";
export { loadAllowedSendersWithSource, SENDER_ID_RE } from "./channels/allowed-senders.js";

// ─── Updater ──────────────────────────────────────────────────────────
export {
  buildCheckUrl,
  checkForUpdate,
  getCurrentVersion,
  getInstanceId,
  getKnownTelegramChatIds,
  getLastNotifiedVersion,
  isManagedDeploy,
  isUpdateAvailable,
  MANAGED_DEPLOY_UPDATE_NOTICE,
  selfUpdate,
  setLastNotifiedVersion,
} from "./updater.js";
export type { UpdateInfo } from "./updater.js";

// ─── Release notes ───────────────────────────────────────────────────
export { fetchLatestReleaseNotes } from "./release-notes.js";
export type {
  FetchLatestReleaseNotesOptions,
  ReleaseNotesFetch,
  ReleaseNotesResult,
  RepoInfo,
} from "./release-notes.js";
