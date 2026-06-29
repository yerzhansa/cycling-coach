// ─── Binary deployment shell ──────────────────────────────────────────
export type { BinaryConfig } from "./binary.js";
export { getCoachHome } from "./coach-home.js";

// ─── Setup wizard ─────────────────────────────────────────────────────
export { runSetup } from "./setup.js";

// ─── Binary entry point ───────────────────────────────────────────────
export { runBinary } from "./run-binary.js";
export type { RunBinaryHooks } from "./run-binary.js";
export { reportFatal } from "./process-guard.js";

// ─── Sport contract ───────────────────────────────────────────────────
export type {
  CoreDeps,
  IntervalsActivityType,
  MemorySectionSpec,
  Person,
  Sport,
  SportId,
  SportMemoryShape,
  SportPersona,
  ToolRegistration,
} from "./sport.js";
export { mergeSportSkills } from "./sport.js";

// ─── Reference layer (see NOTICE.md for upstream attribution) ────────
// Per-sport seam types, freshness/timing constants, path resolver, I/O
// helpers, strict Zod cache schemas with per-file SCHEMA_VERSION
// constants, REFERENCE_PRESERVE_TOKENS, and downstream submodules
// (sync, metrics, validation, curator, units, audit) as they come online.
export * from "./reference/index.js";

// ─── LLM ──────────────────────────────────────────────────────────────
export { LLM } from "./llm.js";
export type { GenerateOpts, GenerateResult } from "./llm-types.js";
export { appendUsageLine, USAGE_LEDGER_FILE, USAGE_LEDGER_MAX_BYTES } from "./usage-ledger.js";
export type { UsageLedgerLine } from "./usage-ledger.js";

// ─── Logging substrate ────────────────────────────────────────────────
export {
  createSubsystemLogger,
  createSubsystemLoggers,
  serializeError,
  LOG_LEVELS,
  normalizeLogLevel,
} from "./logging/index.js";
export type { LogLine, LogLevel, SubsystemLogger, Subsystem } from "./logging/index.js";

// ─── Memory ───────────────────────────────────────────────────────────
export type { MemorySnapshot, MemoryStore, MemoryWriteSource } from "./memory.js";
export { Memory } from "./memory/store.js";
export type { MemoryJournalEntry } from "./memory/journal.js";
export { createMemorySnapshot } from "./memory/snapshot.js";
export { CORE_SHARED_SECTIONS } from "./memory/shared-sections.js";
export {
  getEffectiveSections,
  _resetWarnCacheForTesting,
} from "./memory/effective-sections.js";

// ─── Secrets ──────────────────────────────────────────────────────────
export type {
  EnvSecretRef,
  ExecSecretRef,
  SecretRef,
  SecretsResolver,
} from "./secrets/types.js";
export { SecretResolutionError, isSecretRef } from "./secrets/types.js";
export { resolveSecretRef, _resolveSecretRefWithOverrides } from "./secrets/resolve.js";
export {
  detectBackends,
  _detectBackendsWithOverrides,
  findInPath,
} from "./secrets/backends/detect.js";
export type {
  BackendAvailability,
  KeychainState,
  OpState,
} from "./secrets/backends/detect.js";
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
export {
  TurnBudgetExceededError,
  MAX_TURN_MODEL_CALLS,
  MAX_TURN_GENERATE_ATTEMPTS,
  TURN_WALL_CLOCK_MS,
} from "./agent/turn-budget.js";
export type { BudgetExceededKind, TurnBudget } from "./agent/turn-budget.js";
export { TAINTED_BY_WRITES_MESSAGE } from "./agent/coach-agent-copy.js";
export { capToolResult, TOOL_RESULT_SHARE } from "./agent/tool-result-cap.js";
export {
  memoizeReadTool,
  READ_ONLY_TOOL_NAMES,
  stableStringify,
  memoizeKey,
} from "./agent/read-memoizer.js";
export {
  downsampleStreams,
  STREAM_BIN_SECONDS,
  STREAM_RESULT_TARGET_TOKENS,
} from "./agent/stream-downsample.js";
export type { DownsampledStreams } from "./agent/stream-downsample.js";
export { ChatStore } from "./agent/chat-store.js";
export {
  buildSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  STEP_BUDGET_RULES,
} from "./agent/system-prompt.js";
export { computePromptLineage } from "./agent/prompt-lineage.js";
export type { PromptLineage, PromptLineageInput } from "./agent/prompt-lineage.js";
export { withSessionLock } from "./agent/session-lock.js";
export {
  splitHistoryByBudget,
  makeSummaryMessage,
  SUMMARY_PREFIX,
} from "./agent/history-limit.js";
export {
  CHARS_PER_TOKEN,
  MIN_PROMPT_BUDGET_TOKENS,
  RESERVE_TOKENS,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  TIMEOUT_COMPACTION_THRESHOLD,
  computeHistoryTokenBudget,
  estimateMessagesTokens,
  estimateTokens,
  extractRetryAfterMs,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  messageText,
  shouldCompact,
} from "./agent/token-utils.js";
export {
  auditSummaryQuality,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
  summarizeDroppedMessages,
  summarizeInStages,
} from "./agent/compaction.js";
export { runMemoryFlush } from "./agent/memory-flush.js";
export type { MemoryFlushOutcome } from "./agent/memory-flush.js";
export {
  evaluateSessionFreshness,
  resolveDailyResetAtMs,
} from "./agent/session-freshness.js";
export {
  createMemoryQueryTool,
  createMemoryReadTool,
  createMemoryTools,
} from "./agent/tools.js";
export {
  createPureCoreIntervalsTools,
  createCoreToolsWithSportConfig,
} from "./agent/intervals-tools.js";
export {
  appendCurrentTimeLine,
  buildCurrentTimeLine,
  formatTimeInTZ,
  isValidTimezone,
  resolveUserTimezone,
  todayInTZ,
} from "./agent/user-time.js";

// ─── Auth ─────────────────────────────────────────────────────────────
export {
  RefreshTokenReusedError,
  getFreshToken,
  loadProfile,
  saveProfile,
} from "./auth/profiles.js";
export type { OAuthCredential } from "./auth/profiles.js";
export { runCodexLogin } from "./auth/openai-codex-login.js";

// ─── Channels ─────────────────────────────────────────────────────────
export { createTelegramBot, notifyUpdate } from "./channels/telegram.js";

// ─── Config ───────────────────────────────────────────────────────────
export {
  CONFIG_DIR,
  CONFIG_FILE,
  loadConfig,
  readConfigYaml,
  resolveConfigSecrets,
} from "./config.js";
export type { Config } from "./config.js";

// ─── Updater ──────────────────────────────────────────────────────────
export {
  checkForUpdate,
  getCurrentVersion,
  getKnownTelegramChatIds,
  getLastNotifiedVersion,
  isManagedDeploy,
  isUpdateAvailable,
  MANAGED_DEPLOY_UPDATE_NOTICE,
  selfUpdate,
  setLastNotifiedVersion,
} from "./updater.js";
export type { UpdateInfo } from "./updater.js";
