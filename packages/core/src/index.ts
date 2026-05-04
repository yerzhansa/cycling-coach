// ─── Binary deployment shell ──────────────────────────────────────────
export type { BinaryConfig } from "./binary.js";

// ─── Setup wizard ─────────────────────────────────────────────────────
export { runSetup } from "./setup.js";

// ─── Binary entry point ───────────────────────────────────────────────
export { runBinary } from "./run-binary.js";
export type { RunBinaryHooks } from "./run-binary.js";

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

// ─── LLM ──────────────────────────────────────────────────────────────
export { LLM } from "./llm.js";
export type { GenerateOpts, GenerateResult } from "./llm-types.js";

// ─── Memory ───────────────────────────────────────────────────────────
export type { MemorySnapshot, MemoryStore } from "./memory.js";
export { Memory } from "./memory/store.js";
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
export { ChatStore } from "./agent/chat-store.js";
export { buildSystemPrompt } from "./agent/system-prompt.js";
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
export {
  evaluateSessionFreshness,
  resolveDailyResetAtMs,
} from "./agent/session-freshness.js";
export {
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
  isUpdateAvailable,
  selfUpdate,
  setLastNotifiedVersion,
} from "./updater.js";
export type { UpdateInfo } from "./updater.js";
