import { markProviderAuthFailure } from "../../provider-auth-failure.js";
import { CodexProcessExitError, CodexRequestError } from "./protocol.js";

export const CODEX_OVERLOADED_CODE = -32001;

export type CodexAgentConfigErrorKind =
  | "binary-missing"
  | "unsupported-platform"
  | "version-below-floor"
  | "not-signed-in"
  | "account-not-chatgpt"
  | "override-mismatch"
  | "endpoint-not-pinned"
  | "mcp-isolation"
  | "probe-timeout";

export class CodexAgentConfigError extends Error {
  readonly kind: CodexAgentConfigErrorKind;

  constructor(kind: CodexAgentConfigErrorKind, message: string) {
    super(message);
    this.name = "CodexAgentConfigError";
    this.kind = kind;
  }
}

const LAUNCHD_PATH_HINT =
  "(Mac launchd users: set an absolute path like '/opt/homebrew/bin/codex'.)";

export const WINDOWS_UNSUPPORTED_MESSAGE =
  "The Codex agent provider is not supported on Windows yet (macOS and Linux only). Track the Windows lane in the project backlog.";

export const NOT_SIGNED_IN_MESSAGE =
  "Codex CLI is not signed in. Open a terminal, run codex login, and sign in with your ChatGPT plan. Enduragent never signs in for you.";

export const PROBE_TIMEOUT_MESSAGE =
  "Codex CLI readiness check timed out. Retry, or check that codex app-server starts in your terminal.";

export function binaryMissingMessage(binaryPath: string): string {
  return `Codex CLI not found at ${binaryPath}. Install it and run codex login, or set llm.codex_agent.binary_path. ${LAUNCHD_PATH_HINT}`;
}

export function versionBelowFloorMessage(version: string, floor: string): string {
  return `Codex CLI ${version} is older than the minimum supported ${floor}. Update codex.`;
}

export function accountNotChatgptMessage(accountType: string): string {
  return `Codex CLI is authenticated as '${accountType}', not a ChatGPT subscription. This lane requires a ChatGPT plan sign-in.`;
}

export function overrideMismatchMessage(key: string): string {
  return `Codex CLI refused a required safety setting (${key}). This machine's managed configuration is incompatible with the coaching lane.`;
}

export function endpointNotPinnedMessage(key: string): string {
  return `Codex CLI is configured to route model requests to a custom endpoint (${key}). The coaching lane requires the default OpenAI/ChatGPT endpoint.`;
}

export function mcpIsolationMessage(detail: string): string {
  return `Cannot safely isolate the Codex MCP configuration on this machine (${detail}). Rename or disable the offending server in ~/.codex/config.toml, or choose another provider.`;
}

export function binaryMissingError(binaryPath: string): CodexAgentConfigError {
  return new CodexAgentConfigError("binary-missing", binaryMissingMessage(binaryPath));
}

export function unsupportedPlatformError(): CodexAgentConfigError {
  return new CodexAgentConfigError("unsupported-platform", WINDOWS_UNSUPPORTED_MESSAGE);
}

export function versionBelowFloorError(version: string, floor: string): CodexAgentConfigError {
  return new CodexAgentConfigError(
    "version-below-floor",
    versionBelowFloorMessage(version, floor),
  );
}

export function notSignedInError(): CodexAgentConfigError {
  return markProviderAuthFailure(
    new CodexAgentConfigError("not-signed-in", NOT_SIGNED_IN_MESSAGE),
  );
}

export function accountNotChatgptError(accountType: string): CodexAgentConfigError {
  return markProviderAuthFailure(
    new CodexAgentConfigError("account-not-chatgpt", accountNotChatgptMessage(accountType)),
  );
}

export function overrideMismatchError(key: string): CodexAgentConfigError {
  return new CodexAgentConfigError("override-mismatch", overrideMismatchMessage(key));
}

export function endpointNotPinnedError(key: string): CodexAgentConfigError {
  return new CodexAgentConfigError("endpoint-not-pinned", endpointNotPinnedMessage(key));
}

export function mcpIsolationError(detail: string): CodexAgentConfigError {
  return new CodexAgentConfigError("mcp-isolation", mcpIsolationMessage(detail));
}

export function probeTimeoutError(): CodexAgentConfigError {
  return new CodexAgentConfigError("probe-timeout", PROBE_TIMEOUT_MESSAGE);
}

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}/g;
const BEARER_PATTERN = /Bearer\s+\S+/gi;
const SK_KEY_PATTERN = /sk-[A-Za-z0-9_-]{16,}/g;

export function redactSecretShapes(text: string): string {
  return text
    .replace(JWT_PATTERN, "[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SK_KEY_PATTERN, "[redacted]");
}

const AUTH_FAILURE_PATTERN =
  /token expired|refresh token|please run codex login|not logged in|not signed in|invalid[ _-]?api[ _-]?key|authentication_error|unauthorized|\b401\b|\b403\b/i;

const RATE_LIMIT_PATTERN = /usage.?limit|rate.?limit|too many requests|\b429\b/i;

const OVERFLOW_PATTERN =
  /context.?length|context.?window|maximum context|token limit|too many tokens|content_too_large|prompt is too long|exceeds the maximum|input token count/i;

const TIMEOUT_PATTERN = /request was aborted|timeout|timed out|deadline|stalled/i;

const SUBPROCESS_DEATH_PATTERN =
  /\bepipe\b|\becconnreset\b|\benoent\b|\besrch\b|process exited|exited with code|killed by signal|sigkill|sigterm|closed unexpectedly|stream closed/i;

const SERVER_ERROR_PATTERN =
  /error_during_execution|\b5\d{2}\b|internal server error|bad gateway|service unavailable|overloaded/i;

const RETRY_AFTER_PATTERN = /retry[ -]?after[:= ]+(\d+)/i;

const SERVER_ERROR_HTTP_STATUSES = new Set([500, 502, 503, 504]);

interface ErrorCarrier {
  httpStatus?: number;
  retryAfterMs?: number;
  code?: unknown;
  cause?: unknown;
}

export interface NormalizeHint {
  retryAfterMs?: number;
  message?: string;
  fallback?: "server-error";
}

function readRetryAfterMs(
  carried: ErrorCarrier,
  text: string,
  hint?: NormalizeHint,
): number | undefined {
  if (hint?.retryAfterMs !== undefined) return hint.retryAfterMs;
  if (carried.retryAfterMs !== undefined) return carried.retryAfterMs;
  const match = RETRY_AFTER_PATTERN.exec(text);
  if (match?.[1] === undefined) return undefined;
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function named(name: string, message: string): Error {
  const out = new Error(message);
  out.name = name;
  return out;
}

export function normalizeCodexAgentError(err: unknown, hint?: NormalizeHint): Error {
  if (err instanceof CodexAgentConfigError) return err;

  const base = err instanceof Error ? err : new Error(String(err));
  if (base.name === "AbortError") return base;

  const carried = base as Error & ErrorCarrier;
  const text = redactSecretShapes(
    [base.message ?? "", hint?.message ?? ""].filter(Boolean).join(" | "),
  );

  if (err instanceof CodexProcessExitError) {
    const out = named("NetworkError", text) as Error & ErrorCarrier;
    out.cause = base;
    return out;
  }

  if (AUTH_FAILURE_PATTERN.test(text)) return notSignedInError();

  const jsonRpcCode = err instanceof CodexRequestError ? err.code : undefined;
  if (
    jsonRpcCode === CODEX_OVERLOADED_CODE ||
    carried.httpStatus === 429 ||
    RATE_LIMIT_PATTERN.test(text)
  ) {
    const out = named("RateLimitError", `Rate limit exceeded: ${text}`) as Error & ErrorCarrier;
    const retryAfterMs = readRetryAfterMs(carried, text, hint);
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
    return out;
  }

  if (OVERFLOW_PATTERN.test(text)) return named("ContextOverflowError", `Context overflow: ${text}`);

  if (TIMEOUT_PATTERN.test(text)) return named("TimeoutError", `Request timeout: ${text}`);

  if (typeof carried.code === "string" && SUBPROCESS_DEATH_PATTERN.test(carried.code)) {
    const out = named("NetworkError", text) as Error & ErrorCarrier;
    out.cause = base.cause ?? base;
    return out;
  }

  if (SUBPROCESS_DEATH_PATTERN.test(text)) {
    const out = named("NetworkError", text) as Error & ErrorCarrier;
    out.cause = base.cause ?? base;
    return out;
  }

  if (
    (carried.httpStatus !== undefined && SERVER_ERROR_HTTP_STATUSES.has(carried.httpStatus)) ||
    SERVER_ERROR_PATTERN.test(text) ||
    hint?.fallback === "server-error"
  ) {
    const out = named("ServerError", `Server error: ${text}`) as Error & ErrorCarrier;
    const retryAfterMs = readRetryAfterMs(carried, text, hint);
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
    return out;
  }

  if (text === base.message) return base;
  const out = named(base.name, text) as Error & ErrorCarrier;
  out.cause = base.cause ?? base;
  return out;
}
