export type ClaudeCliConfigErrorKind =
  | "binary-missing"
  | "version-below-floor"
  | "not-signed-in"
  | "probe-timeout"
  | "api-key-identity"
  | "unrecognized-auth-source"
  | "api-key-unapproved";

export class ClaudeCliConfigError extends Error {
  readonly kind: ClaudeCliConfigErrorKind;

  constructor(kind: ClaudeCliConfigErrorKind, message: string) {
    super(message);
    this.name = "ClaudeCliConfigError";
    this.kind = kind;
  }
}

const LAUNCHD_PATH_HINT =
  "(Mac launchd users: set an absolute path like '/opt/homebrew/bin/claude'.)";

export const NOT_SIGNED_IN_MESSAGE =
  "Claude Code CLI is not signed in. Open a terminal, run claude, and sign in with your Claude subscription. Enduragent never signs in for you.";

export const PROBE_TIMEOUT_MESSAGE =
  "Claude Code CLI account probe timed out. Retry, or check that claude starts in your terminal.";

export const API_KEY_IDENTITY_MESSAGE =
  "Claude Code CLI is authenticated with an API key/token, not a subscription. Sign in with your subscription in claude, or set llm.claude_cli.billing: api-key to opt in to API billing.";

export const API_KEY_UNAPPROVED_MESSAGE =
  "Your API key is not approved in the Claude CLI — run claude once with it and approve, or set llm.claude_cli.billing: subscription.";

export function binaryMissingMessage(binaryPath: string): string {
  return `Claude Code CLI not found at ${binaryPath}. Install it (https://claude.com/claude-code) or set llm.claude_cli.binary_path. ${LAUNCHD_PATH_HINT}`;
}

export function versionBelowFloorMessage(version: string, floor: string): string {
  return `Claude Code CLI ${version} is older than the minimum supported ${floor}. Run: claude update`;
}

export function unrecognizedAuthSourceMessage(raw: string): string {
  return `Unrecognized Claude CLI auth source '${raw}' — update enduragent, or opt in with llm.claude_cli.billing: api-key.`;
}

export function binaryMissingError(binaryPath: string): ClaudeCliConfigError {
  return new ClaudeCliConfigError("binary-missing", binaryMissingMessage(binaryPath));
}

export function versionBelowFloorError(version: string, floor: string): ClaudeCliConfigError {
  return new ClaudeCliConfigError("version-below-floor", versionBelowFloorMessage(version, floor));
}

export function notSignedInError(): ClaudeCliConfigError {
  return new ClaudeCliConfigError("not-signed-in", NOT_SIGNED_IN_MESSAGE);
}

export function probeTimeoutError(): ClaudeCliConfigError {
  return new ClaudeCliConfigError("probe-timeout", PROBE_TIMEOUT_MESSAGE);
}

export function apiKeyIdentityError(): ClaudeCliConfigError {
  return new ClaudeCliConfigError("api-key-identity", API_KEY_IDENTITY_MESSAGE);
}

export function unrecognizedAuthSourceError(raw: string): ClaudeCliConfigError {
  return new ClaudeCliConfigError("unrecognized-auth-source", unrecognizedAuthSourceMessage(raw));
}

export function apiKeyUnapprovedError(): ClaudeCliConfigError {
  return new ClaudeCliConfigError("api-key-unapproved", API_KEY_UNAPPROVED_MESSAGE);
}

const AUTH_FAILURE_PATTERN =
  /oauth token expired|please run \/login|not logged in|invalid[ _-]?api[ _-]?key|authentication_error|unauthorized|\b401\b|\b403\b/i;

const RATE_LIMIT_PATTERN = /usage.?limit|rate.?limit|too many requests|\b429\b/i;

const OVERFLOW_PATTERN =
  /context.?length|context.?window|maximum context|token limit|too many tokens|content_too_large|prompt is too long|exceeds the maximum/i;

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

export function normalizeClaudeCliError(err: unknown, hint?: NormalizeHint): Error {
  if (err instanceof ClaudeCliConfigError) return err;

  const base = err instanceof Error ? err : new Error(String(err));
  if (base.name === "AbortError") return base;

  const carried = base as Error & ErrorCarrier;
  const text = [base.message ?? "", hint?.message ?? ""].filter(Boolean).join(" | ");

  if (AUTH_FAILURE_PATTERN.test(text)) return notSignedInError();

  if (carried.httpStatus === 429 || RATE_LIMIT_PATTERN.test(text)) {
    const out = named("RateLimitError", `Rate limit exceeded: ${text}`) as Error & ErrorCarrier;
    const retryAfterMs = readRetryAfterMs(carried, text, hint);
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
    return out;
  }

  if (OVERFLOW_PATTERN.test(text))
    return named("ContextOverflowError", `Context overflow: ${text}`);

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
    SERVER_ERROR_PATTERN.test(text)
  ) {
    const out = named("ServerError", `Server error: ${text}`) as Error & ErrorCarrier;
    const retryAfterMs = readRetryAfterMs(carried, text, hint);
    if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
    return out;
  }

  return base;
}
