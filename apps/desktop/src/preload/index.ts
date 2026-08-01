import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_LIFECYCLE_CHANNEL,
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_RELEASE_NOTES_CHANNEL,
  DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL,
  DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL,
  DESKTOP_TRANSCRIPT_PAGE_CHANNEL,
  DESKTOP_UPDATE_CHECK_CHANNEL,
  DESKTOP_UPDATE_GET_CHANNEL,
  DESKTOP_UPDATE_RESTART_CHANNEL,
  DESKTOP_UPDATE_STATE_CHANNEL,
} from "../main/constants.js";

const DESKTOP_CREDENTIAL_STATUS_CHANNEL = "enduragent:onboarding:credential-status";
const DESKTOP_CREDENTIAL_RETRY_CHANNEL = "enduragent:onboarding:credential-retry";
const DESKTOP_CREDENTIAL_WRITE_CHANNEL = "enduragent:onboarding:credential-write";
const DESKTOP_CREDENTIAL_DELETE_CHANNEL = "enduragent:settings:credential-delete";
const DESKTOP_LLM_CONFIGURATION_CHANNEL = "enduragent:onboarding:llm-configuration";
const DESKTOP_LLM_SELECTION_APPLY_CHANNEL = "enduragent:onboarding:llm-selection-apply";
const DESKTOP_CHATGPT_STATUS_CHANNEL = "enduragent:onboarding:chatgpt-status";
const DESKTOP_CHATGPT_LOGIN_CHANNEL = "enduragent:onboarding:chatgpt-login";
const DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL = "enduragent:onboarding:choose-import-files";

const SLOTS = new Set([
  "anthropic",
  "openrouter",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "intervals-icu",
]);
const CREDENTIALS = new Set([...SLOTS, "openai-codex"]);
const LLM_PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "claude-cli",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
] as const;
const LLM_PROVIDERS = new Set<string>(LLM_PROVIDER_ORDER);
const DEFAULT_ENDPOINT_PROVIDERS = new Set([
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
]);
const STATES = new Set(["missing", "configured", "re-prompt"]);
const RUNTIME_STATES = new Set(["active", "stored-inactive", "failed"]);
const REASONS = new Set([
  "invalid-input",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "runtime-unavailable",
  "training-account-mismatch",
]);
const DELETE_REASONS = new Set([
  "not-found",
  "managed-by-environment",
  "storage-failed",
  "runtime-unavailable",
  "runtime-state-diverged",
]);
const CHATGPT_REASONS = new Set([
  "already-in-progress",
  "callback-unavailable",
  "timed-out",
  "cancelled",
  "exchange-failed",
  "storage-failed",
  "runtime-unavailable",
]);
const IMPORT_EXTENSIONS = new Set([".fit", ".tcx", ".gpx"]);
const RELEASES_URL = "https://github.com/yerzhansa/enduragent/releases";
const RELEASE_NOTES_MAX_TOTAL_BYTES = 64 * 1024;
const TRANSCRIPT_PAGE_MAX_TURNS = 50;
const TRANSCRIPT_PAGE_MAX_RESPONSE_BYTES = 266_240;
const TRANSCRIPT_CURSOR_LENGTH = 152;
const TRANSCRIPT_CURSOR_PATTERN = /^[A-Za-z0-9_-]{152}$/;
const TRANSCRIPT_CURSOR_VERSION = 1;
const ARCHIVED_TRANSCRIPT_CURSOR_VERSION = 2;
const ARCHIVED_CONVERSATIONS_MAX_ENTRIES = 200;
const BOUNDARY_REF_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const RELEASE_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const textEncoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function decodedBase64Url(value: string): Uint8Array | null {
  let accumulator = 0;
  let bits = 0;
  const decoded: number[] = [];
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  return bits === 0 ? Uint8Array.from(decoded) : null;
}

function safeCursorOffset(bytes: Uint8Array, offset: number): number | null {
  let value = 0;
  for (let index = offset; index < offset + 8; index += 1) {
    value = value * 256 + bytes[index]!;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function cursorOfVersion(value: unknown, version: number, archived: boolean): value is string {
  if (
    typeof value !== "string" ||
    value.length !== TRANSCRIPT_CURSOR_LENGTH ||
    !TRANSCRIPT_CURSOR_PATTERN.test(value)
  ) {
    return false;
  }
  const bytes = decodedBase64Url(value);
  if (bytes === null || bytes.length !== 114 || bytes[0] !== version) return false;
  const fenceKind = bytes[1];
  if (fenceKind !== 0 && fenceKind !== 1) return false;
  if (archived && fenceKind !== 1) return false;
  if (fenceKind === 0 && bytes.slice(34, 66).some((byte) => byte !== 0)) return false;
  const snapshotEnd = safeCursorOffset(bytes, 98);
  const before = safeCursorOffset(bytes, 106);
  return snapshotEnd !== null && before !== null && before <= snapshotEnd;
}

function transcriptCursor(value: unknown): value is string {
  return cursorOfVersion(value, TRANSCRIPT_CURSOR_VERSION, false);
}

function archivedTranscriptCursor(value: unknown): value is string {
  return cursorOfVersion(value, ARCHIVED_TRANSCRIPT_CURSOR_VERSION, true);
}

function boundaryRef(value: unknown): value is string {
  return typeof value === "string" && BOUNDARY_REF_PATTERN.test(value);
}

function boundedPageLimit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= TRANSCRIPT_PAGE_MAX_TURNS
  );
}

function parseTranscriptPageRequest(value: unknown): {
  readonly cursor: string | null;
  readonly limit: number;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["cursor", "limit"]) ||
    (value.cursor !== null && !transcriptCursor(value.cursor)) ||
    !boundedPageLimit(value.limit)
  ) {
    throw new TypeError();
  }
  return { cursor: value.cursor as string | null, limit: value.limit };
}

function parseArchivedPageRequest(value: unknown): {
  readonly boundaryRef: string;
  readonly cursor: string | null;
  readonly limit: number;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["boundaryRef", "cursor", "limit"]) ||
    !boundaryRef(value.boundaryRef) ||
    (value.cursor !== null && !archivedTranscriptCursor(value.cursor)) ||
    !boundedPageLimit(value.limit)
  ) {
    throw new TypeError();
  }
  return {
    boundaryRef: value.boundaryRef,
    cursor: value.cursor as string | null,
    limit: value.limit,
  };
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseTranscriptPage(
  value: unknown,
  cursor: (candidate: unknown) => candidate is string = transcriptCursor,
): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "status", "turns", "nextCursor"]) ||
    value.schemaVersion !== 1 ||
    (value.status !== "page" && value.status !== "restart-required") ||
    !Array.isArray(value.turns) ||
    value.turns.length > TRANSCRIPT_PAGE_MAX_TURNS ||
    (value.nextCursor !== null && !cursor(value.nextCursor)) ||
    textEncoder.encode(JSON.stringify(value)).byteLength > TRANSCRIPT_PAGE_MAX_RESPONSE_BYTES
  ) {
    throw new TypeError();
  }
  const turns = value.turns.map((turn) => {
    if (
      !record(turn) ||
      !exactKeys(turn, ["turnId", "completedAt", "athleteText", "coachText"]) ||
      typeof turn.turnId !== "string" ||
      turn.turnId.length === 0 ||
      !canonicalIsoTimestamp(turn.completedAt) ||
      typeof turn.athleteText !== "string" ||
      typeof turn.coachText !== "string"
    ) {
      throw new TypeError();
    }
    return {
      turnId: turn.turnId,
      completedAt: turn.completedAt,
      athleteText: turn.athleteText,
      coachText: turn.coachText,
    };
  });
  if (value.status === "restart-required" && (turns.length !== 0 || value.nextCursor !== null)) {
    throw new TypeError();
  }
  if (value.status === "page" && turns.length === 0 && value.nextCursor !== null) {
    throw new TypeError();
  }
  return {
    schemaVersion: 1,
    status: value.status,
    turns,
    nextCursor: value.nextCursor,
  };
}

function parseArchivedConversations(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "conversations", "truncated"]) ||
    value.schemaVersion !== 1 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > ARCHIVED_CONVERSATIONS_MAX_ENTRIES ||
    (value.truncated && value.conversations.length < ARCHIVED_CONVERSATIONS_MAX_ENTRIES)
  ) {
    throw new TypeError();
  }
  const conversations = value.conversations.map((entry) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["boundaryRef", "boundaryAt", "reason", "turnCount"]) ||
      !boundaryRef(entry.boundaryRef) ||
      !canonicalIsoTimestamp(entry.boundaryAt) ||
      (entry.reason !== "explicit-reset" && entry.reason !== "stale-reset") ||
      !Number.isSafeInteger(entry.turnCount) ||
      (entry.turnCount as number) < 0
    ) {
      throw new TypeError();
    }
    return {
      boundaryRef: entry.boundaryRef,
      boundaryAt: entry.boundaryAt,
      reason: entry.reason,
      turnCount: entry.turnCount as number,
    };
  });
  if (new Set(conversations.map((entry) => entry.boundaryRef)).size !== conversations.length) {
    throw new TypeError();
  }
  return { schemaVersion: 1, conversations, truncated: value.truncated };
}

function safeString(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function normalizedSelectionText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) throw new TypeError();
  return normalized;
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

function normalizedEndpoint(value: unknown): string {
  const normalized = normalizedSelectionText(value, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.href.includes("?") ||
    parsed.href.includes("#") ||
    parsed.hostname.length === 0 ||
    (parsed.protocol === "http:" && !loopbackHost(parsed.hostname))
  ) {
    throw new TypeError();
  }
  return normalized;
}

type PreloadLlmSelection = {
  readonly provider: (typeof LLM_PROVIDER_ORDER)[number];
  readonly model: string;
  readonly endpoint:
    | { readonly mode: "automatic" }
    | { readonly mode: "default" }
    | { readonly mode: "custom"; readonly value: string };
};

function parseLlmSelection(value: unknown): PreloadLlmSelection {
  if (!record(value) || !exactKeys(value, ["provider", "model", "endpoint"])) {
    throw new TypeError();
  }
  if (typeof value.provider !== "string" || !LLM_PROVIDERS.has(value.provider)) {
    throw new TypeError();
  }
  const provider = value.provider as PreloadLlmSelection["provider"];
  const model = normalizedSelectionText(value.model, 512);
  if (!record(value.endpoint) || typeof value.endpoint.mode !== "string") {
    throw new TypeError();
  }
  let endpoint: PreloadLlmSelection["endpoint"];
  if (value.endpoint.mode === "automatic" && exactKeys(value.endpoint, ["mode"])) {
    endpoint = { mode: "automatic" };
  } else if (value.endpoint.mode === "default" && exactKeys(value.endpoint, ["mode"])) {
    endpoint = { mode: "default" };
  } else if (value.endpoint.mode === "custom" && exactKeys(value.endpoint, ["mode", "value"])) {
    endpoint = { mode: "custom", value: normalizedEndpoint(value.endpoint.value) };
  } else {
    throw new TypeError();
  }
  if (endpoint.mode !== "automatic" && !DEFAULT_ENDPOINT_PROVIDERS.has(provider)) {
    throw new TypeError();
  }
  return { provider, model, endpoint };
}

function parseChatGptSelection(value: unknown): PreloadLlmSelection {
  const selection = parseLlmSelection(value);
  if (selection.provider !== "openai-codex" || selection.endpoint.mode !== "automatic") {
    throw new TypeError();
  }
  return selection;
}

function parseCredentialWriteInput(value: unknown): {
  readonly slot: string;
  readonly value: string;
  readonly selection?: PreloadLlmSelection;
} {
  if (!record(value)) throw new TypeError();
  const hasSelection = Object.hasOwn(value, "selection");
  if (
    !exactKeys(value, hasSelection ? ["slot", "value", "selection"] : ["slot", "value"]) ||
    !SLOTS.has(value.slot as string) ||
    typeof value.value !== "string"
  ) {
    throw new TypeError();
  }
  if (!hasSelection) return { slot: value.slot as string, value: value.value };
  if (value.slot === "intervals-icu") throw new TypeError();
  const selection = parseLlmSelection(value.selection);
  if (selection.provider !== value.slot) throw new TypeError();
  return { slot: value.slot as string, value: value.value, selection };
}

function parseCredentialDeleteInput(value: unknown): { readonly credential: string } {
  if (
    !record(value) ||
    !exactKeys(value, ["credential"]) ||
    typeof value.credential !== "string" ||
    !CREDENTIALS.has(value.credential)
  ) {
    throw new TypeError();
  }
  return { credential: value.credential };
}

function releaseVersion(value: unknown): value is string {
  return safeString(value, 64) && RELEASE_VERSION_RE.test(value);
}

function releaseTagUrl(version: string): string {
  return `${RELEASES_URL}/tag/cycling-coach@${encodeURIComponent(version)}`;
}

function parseReleaseNotes(value: unknown): unknown {
  if (!record(value) || (value.status !== "available" && value.status !== "unavailable")) {
    throw new TypeError();
  }
  if (value.status === "unavailable") {
    if (
      !exactKeys(value, ["status", "version", "releaseUrl"]) ||
      (value.version !== null && !releaseVersion(value.version)) ||
      typeof value.releaseUrl !== "string" ||
      value.releaseUrl.length > 2_048 ||
      value.releaseUrl !== (value.version === null ? RELEASES_URL : releaseTagUrl(value.version))
    ) {
      throw new TypeError();
    }
    return {
      status: "unavailable",
      version: value.version,
      releaseUrl: value.releaseUrl,
    };
  }
  if (
    !exactKeys(value, ["status", "version", "notes", "releaseUrl"]) ||
    !releaseVersion(value.version) ||
    !Array.isArray(value.notes) ||
    value.notes.length > 100 ||
    typeof value.releaseUrl !== "string" ||
    value.releaseUrl.length > 2_048 ||
    value.releaseUrl !== releaseTagUrl(value.version)
  ) {
    throw new TypeError();
  }
  let totalBytes = 0;
  const notes = value.notes.map((note) => {
    if (!safeString(note, 2_000)) throw new TypeError();
    totalBytes += textEncoder.encode(note).byteLength;
    if (totalBytes > RELEASE_NOTES_MAX_TOTAL_BYTES) throw new TypeError();
    return note;
  });
  return {
    status: "available",
    version: value.version,
    notes,
    releaseUrl: value.releaseUrl,
  };
}

type PreloadUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | { readonly status: "downloading" | "downloaded" | "installing"; readonly version: string }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

function parseUpdateState(value: unknown): PreloadUpdateState {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (["disabled", "idle", "checking", "current"].includes(value.status)) {
    if (!exactKeys(value, ["status"])) throw new TypeError();
    return { status: value.status as "disabled" | "idle" | "checking" | "current" };
  }
  if (["downloading", "downloaded", "installing"].includes(value.status)) {
    if (
      !exactKeys(value, ["status", "version"]) ||
      !safeString(value.version, 64) ||
      !STABLE_VERSION_RE.test(value.version)
    ) {
      throw new TypeError();
    }
    return {
      status: value.status as "downloading" | "downloaded" | "installing",
      version: value.version,
    };
  }
  if (
    value.status !== "failed" ||
    !exactKeys(value, ["status", "stage"]) ||
    (value.stage !== "check" && value.stage !== "download")
  ) {
    throw new TypeError();
  }
  return { status: "failed", stage: value.stage };
}

function parseStatuses(value: unknown): unknown {
  if (
    !Array.isArray(value) ||
    value.length !== SLOTS.size ||
    new Set(value.map((entry) => (record(entry) ? entry.slot : undefined))).size !== SLOTS.size
  ) {
    throw new TypeError();
  }
  return value.map((entry) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["slot", "state", "runtimeState"]) ||
      !SLOTS.has(entry.slot as string) ||
      !STATES.has(entry.state as string) ||
      (entry.state === "configured"
        ? !RUNTIME_STATES.has(entry.runtimeState as string)
        : entry.runtimeState !== null)
    ) {
      throw new TypeError();
    }
    return { slot: entry.slot, state: entry.state, runtimeState: entry.runtimeState };
  });
}

function parseWriteResult(value: unknown): unknown {
  if (!record(value) || !SLOTS.has(value.slot as string)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["slot", "status", "runtimeReady"]) &&
    typeof value.runtimeReady === "boolean"
  ) {
    return { slot: value.slot, status: "configured", runtimeReady: value.runtimeReady };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["slot", "status", "reason"]) &&
    REASONS.has(value.reason as string)
  ) {
    return { slot: value.slot, status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseDeleteResult(value: unknown): unknown {
  if (
    !record(value) ||
    typeof value.credential !== "string" ||
    !CREDENTIALS.has(value.credential)
  ) {
    throw new TypeError();
  }
  if (
    value.status === "deleted" &&
    exactKeys(value, ["credential", "status", "cleanupPending"]) &&
    typeof value.cleanupPending === "boolean"
  ) {
    return {
      credential: value.credential,
      status: "deleted",
      cleanupPending: value.cleanupPending,
    };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["credential", "status", "reason"]) &&
    DELETE_REASONS.has(value.reason as string)
  ) {
    return { credential: value.credential, status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseLlmConfiguration(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "providers", "active"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.providers) ||
    value.providers.length !== LLM_PROVIDER_ORDER.length
  ) {
    throw new TypeError();
  }
  const providers = value.providers.map((entry, index) => {
    if (
      !record(entry) ||
      entry.provider !== LLM_PROVIDER_ORDER[index] ||
      typeof entry.provider !== "string"
    ) {
      throw new TypeError();
    }
    const hasDefaultBaseUrl = DEFAULT_ENDPOINT_PROVIDERS.has(entry.provider);
    if (
      !exactKeys(
        entry,
        hasDefaultBaseUrl
          ? ["provider", "defaultModel", "models", "defaultBaseUrl"]
          : ["provider", "defaultModel", "models"],
      ) ||
      !safeString(entry.defaultModel, 512) ||
      !Array.isArray(entry.models) ||
      entry.models.length === 0 ||
      entry.models.length > 100
    ) {
      throw new TypeError();
    }
    if (
      hasDefaultBaseUrl &&
      (typeof entry.defaultBaseUrl !== "string" ||
        normalizedEndpoint(entry.defaultBaseUrl) !== entry.defaultBaseUrl)
    ) {
      throw new TypeError();
    }
    const models = entry.models.map((model) => {
      if (!record(model)) throw new TypeError();
      const hasHint = Object.hasOwn(model, "hint");
      if (
        !exactKeys(model, hasHint ? ["value", "label", "hint"] : ["value", "label"]) ||
        !safeString(model.value, 512) ||
        !safeString(model.label, 512) ||
        (hasHint && !safeString(model.hint, 512))
      ) {
        throw new TypeError();
      }
      return {
        value: model.value,
        label: model.label,
        ...(hasHint ? { hint: model.hint } : {}),
      };
    });
    if (
      new Set(models.map((model) => model.value)).size !== models.length ||
      !models.some((model) => model.value === entry.defaultModel)
    ) {
      throw new TypeError();
    }
    return {
      provider: entry.provider,
      defaultModel: entry.defaultModel,
      models,
      ...(hasDefaultBaseUrl ? { defaultBaseUrl: entry.defaultBaseUrl } : {}),
    };
  });
  let active: { readonly provider: string; readonly model: string } | null = null;
  if (value.active !== null) {
    if (
      !record(value.active) ||
      !exactKeys(value.active, ["provider", "model"]) ||
      typeof value.active.provider !== "string" ||
      !LLM_PROVIDERS.has(value.active.provider) ||
      !safeString(value.active.model, 512)
    ) {
      throw new TypeError();
    }
    active = { provider: value.active.provider, model: value.active.model };
  }
  return { schemaVersion: 1, providers, active };
}

function parseLlmSelectionResult(value: unknown): unknown {
  if (!record(value)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["status", "runtimeReady"]) &&
    value.runtimeReady === true
  ) {
    return { status: "configured", runtimeReady: true };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "reason"]) &&
    ["invalid-input", "credential-required", "runtime-unavailable"].includes(value.reason as string)
  ) {
    return { status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseChatGptStatus(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["state", "runtimeReady"]) ||
    (value.state !== "configured" && value.state !== "absent") ||
    typeof value.runtimeReady !== "boolean"
  ) {
    throw new TypeError();
  }
  return { state: value.state, runtimeReady: value.runtimeReady };
}

function parseChatGptLogin(value: unknown): unknown {
  if (!record(value)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["status", "runtimeReady"]) &&
    value.runtimeReady === true
  ) {
    return { status: "configured", runtimeReady: true };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "reason"]) &&
    CHATGPT_REASONS.has(value.reason as string)
  ) {
    return { status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parsePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError();
  }
  const paths = value.map((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.length > 4_096 ||
      !path.startsWith("/") ||
      path.includes("\0")
    ) {
      throw new TypeError();
    }
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    if (dot <= slash || !IMPORT_EXTENSIONS.has(path.slice(dot).toLowerCase())) {
      throw new TypeError();
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new TypeError();
  return paths;
}

let dropDisposer: (() => void) | undefined;
const updateListeners = new Set<(state: PreloadUpdateState) => void>();

window.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const anchor = event
      .composedPath()
      .find((candidate): candidate is HTMLAnchorElement => candidate instanceof HTMLAnchorElement);
    if (anchor === undefined || anchor.target !== "_blank") return;
    event.preventDefault();
    ipcRenderer.send(DESKTOP_OPEN_EXTERNAL_CHANNEL, anchor.href);
  },
  true,
);

ipcRenderer.on(DESKTOP_LIFECYCLE_CHANNEL, (_event, value: unknown) => {
  if (
    !record(value) ||
    !exactKeys(value, ["generation", "status"]) ||
    !["ready", "recovering", "terminal", "closing"].includes(value.status as string) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("enduragent-lifecycle", {
      detail: { status: value.status, generation: value.generation },
    }),
  );
});

ipcRenderer.on(DESKTOP_UPDATE_STATE_CHANNEL, (_event, value: unknown) => {
  let state: PreloadUpdateState;
  try {
    state = parseUpdateState(value);
  } catch {
    return;
  }
  for (const listener of updateListeners) {
    try {
      listener(parseUpdateState(state));
    } catch {}
  }
});

contextBridge.exposeInMainWorld(
  "enduragentAuth",
  Object.freeze({
    getDaemonConnection: (failedGeneration?: number) => {
      if (
        failedGeneration !== undefined &&
        (!Number.isSafeInteger(failedGeneration) || failedGeneration < 1)
      ) {
        throw new TypeError();
      }
      return ipcRenderer.invoke(
        DESKTOP_CONNECTION_CHANNEL,
        ...(failedGeneration === undefined ? [] : [{ generation: failedGeneration }]),
      );
    },
    getTranscriptPage: async (input: unknown) => {
      const request = parseTranscriptPageRequest(input);
      return parseTranscriptPage(
        await ipcRenderer.invoke(DESKTOP_TRANSCRIPT_PAGE_CHANNEL, request),
      );
    },
    listArchivedConversations: async () =>
      parseArchivedConversations(
        await ipcRenderer.invoke(DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL),
      ),
    getArchivedTranscriptPage: async (input: unknown) => {
      const request = parseArchivedPageRequest(input);
      return parseTranscriptPage(
        await ipcRenderer.invoke(DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL, request),
        archivedTranscriptCursor,
      );
    },
    credentialStatuses: async () =>
      parseStatuses(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL)),
    retryFailedCredentials: async () =>
      parseStatuses(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_RETRY_CHANNEL)),
    writeCredential: async (input: unknown) => {
      const parsed = parseCredentialWriteInput(input);
      return parseWriteResult(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, parsed));
    },
    deleteCredential: async (input: unknown) => {
      const parsed = parseCredentialDeleteInput(input);
      return parseDeleteResult(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, parsed));
    },
    llmConfiguration: async () =>
      parseLlmConfiguration(await ipcRenderer.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL)),
    applyLlmSelection: async (input: unknown) => {
      const selection = parseLlmSelection(input);
      return parseLlmSelectionResult(
        await ipcRenderer.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, selection),
      );
    },
    chatgptStatus: async () =>
      parseChatGptStatus(await ipcRenderer.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL)),
    chatgptLogin: async (input: unknown) => {
      const selection = parseChatGptSelection(input);
      return parseChatGptLogin(await ipcRenderer.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, selection));
    },
    chooseImportFiles: async () =>
      parsePaths(await ipcRenderer.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL)),
    releaseNotes: async () =>
      parseReleaseNotes(await ipcRenderer.invoke(DESKTOP_RELEASE_NOTES_CHANNEL)),
    getUpdateState: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_GET_CHANNEL)),
    checkForUpdates: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_CHECK_CHANNEL)),
    restartToUpdate: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_RESTART_CHANNEL)),
    onUpdateState: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (state: PreloadUpdateState) => void;
      updateListeners.add(typedListener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        updateListeners.delete(typedListener);
      };
    },
    onDroppedImportFiles: (listener: unknown) => {
      if (typeof listener !== "function" || dropDisposer !== undefined) throw new TypeError();
      const onDrop = (event: DragEvent): void => {
        event.preventDefault();
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter((path) => path.length > 0);
        if (paths.length > 0) listener(paths);
      };
      const onDragOver = (event: DragEvent): void => event.preventDefault();
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onDrop);
      const dispose = (): void => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
        if (dropDisposer === dispose) dropDisposer = undefined;
      };
      dropDisposer = dispose;
      return dispose;
    },
  }),
);
