import { markProviderAuthFailure } from "../../provider-auth-failure.js";

export type ClaudeCliConfigErrorKind =
  | "binary-missing"
  | "version-below-floor"
  | "unsupported-windows-executable"
  | "unsafe-windows-command-shim"
  | "windows-mcp-config-write"
  | "windows-mcp-config-cleanup"
  | "working-area-unavailable"
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

export type ClaudeCliWindowsMcpConfigStage = "private-path" | "content-write" | "cleanup";

export class ClaudeCliWindowsMcpConfigError extends ClaudeCliConfigError {
  readonly stage: ClaudeCliWindowsMcpConfigStage;
  readonly cleanupFailure?: ClaudeCliWindowsMcpConfigError;

  constructor(
    kind: Extract<
      ClaudeCliConfigErrorKind,
      "windows-mcp-config-write" | "windows-mcp-config-cleanup"
    >,
    stage: ClaudeCliWindowsMcpConfigStage,
    message: string,
    cleanupFailure?: ClaudeCliWindowsMcpConfigError,
  ) {
    super(kind, message);
    this.name = "ClaudeCliWindowsMcpConfigError";
    this.stage = stage;
    if (cleanupFailure !== undefined) this.cleanupFailure = cleanupFailure;
  }
}

const LAUNCHD_PATH_HINT =
  "(Mac launchd users: set an absolute path like '/opt/homebrew/bin/claude'.)";

export const WINDOWS_CLAUDE_INSTALL_COMMAND = "irm https://claude.ai/install.ps1 | iex";

const WINDOWS_INSTALL_AND_PATH_HINT = `Open PowerShell and run: ${WINDOWS_CLAUDE_INSTALL_COMMAND}. Then restart Enduragent so it reads the updated PATH, or set llm.claude_cli.binary_path to an absolute claude.exe or claude.cmd path.`;

export const NOT_SIGNED_IN_MESSAGE =
  "Claude Code CLI is not signed in. Open a terminal, run claude, and sign in with your Claude subscription. Enduragent never signs in for you.";

export const PROBE_TIMEOUT_MESSAGE =
  "Claude Code CLI account probe timed out. Retry, or check that claude starts in your terminal.";

export const API_KEY_IDENTITY_MESSAGE =
  "Claude Code CLI is authenticated with an API key/token, not a subscription. Sign in with your subscription in claude, or set llm.claude_cli.billing: api-key to opt in to API billing.";

export const API_KEY_UNAPPROVED_MESSAGE =
  "Your API key is not approved in the Claude CLI — run claude once with it and approve, or set llm.claude_cli.billing: subscription.";

export const WORKING_AREA_UNAVAILABLE_MESSAGE =
  "Claude could not be started because Enduragent could not prepare its private working area. Restart Enduragent and try again.";

export type ClaudeWorkingAreaStage =
  | "resolve"
  | "prepare"
  | "entry-check"
  | "binding-check"
  | "permission-check"
  | "spawn-check";

export type ClaudeWorkingAreaFailureCategory =
  | "unavailable"
  | "entry-type"
  | "link-reparse"
  | "root"
  | "overlap"
  | "owner"
  | "permissions"
  | "identity-changed"
  | "not-empty"
  | "repository"
  | "io-failure";

export class ClaudeWorkingAreaError extends ClaudeCliConfigError {
  readonly stage: ClaudeWorkingAreaStage;
  readonly category: ClaudeWorkingAreaFailureCategory;

  constructor(stage: ClaudeWorkingAreaStage, category: ClaudeWorkingAreaFailureCategory) {
    super("working-area-unavailable", WORKING_AREA_UNAVAILABLE_MESSAGE);
    this.name = "ClaudeWorkingAreaError";
    this.stage = stage;
    this.category = category;
  }
}

export function binaryMissingMessage(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `Claude Code CLI was not found on Windows. ${WINDOWS_INSTALL_AND_PATH_HINT}`;
  }
  return `Claude Code CLI not found at ${binaryPath}. Install it (https://claude.com/claude-code) or set llm.claude_cli.binary_path. ${LAUNCHD_PATH_HINT}`;
}

export function versionBelowFloorMessage(
  version: string,
  floor: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `Claude Code CLI ${version} is older than the minimum supported ${floor}. ${WINDOWS_INSTALL_AND_PATH_HINT}`;
  }
  return `Claude Code CLI ${version} is older than the minimum supported ${floor}. Run: claude update`;
}

export function unsupportedWindowsExecutableMessage(): string {
  return `Claude Code CLI on Windows requires an absolute .exe or .cmd path. ${WINDOWS_INSTALL_AND_PATH_HINT}`;
}

export function unsafeWindowsCommandShimMessage(): string {
  return `Enduragent refused the Claude Code .cmd shim because its path or arguments cannot be quoted safely. ${WINDOWS_INSTALL_AND_PATH_HINT}`;
}

export function windowsMcpConfigMessage(stage: ClaudeCliWindowsMcpConfigStage): string {
  if (stage === "cleanup") {
    return "Enduragent could not remove the private Claude Code tool configuration on Windows (stage: cleanup).";
  }
  return `Enduragent could not prepare the private Claude Code tool configuration on Windows (stage: ${stage}). ${WINDOWS_INSTALL_AND_PATH_HINT}`;
}

export function unrecognizedAuthSourceMessage(raw: string): string {
  return `Unrecognized Claude CLI auth source '${raw}' — update enduragent, or opt in with llm.claude_cli.billing: api-key.`;
}

export function binaryMissingError(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeCliConfigError {
  return new ClaudeCliConfigError("binary-missing", binaryMissingMessage(binaryPath, platform));
}

export function versionBelowFloorError(
  version: string,
  floor: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeCliConfigError {
  return new ClaudeCliConfigError(
    "version-below-floor",
    versionBelowFloorMessage(version, floor, platform),
  );
}

export function unsupportedWindowsExecutableError(): ClaudeCliConfigError {
  return new ClaudeCliConfigError(
    "unsupported-windows-executable",
    unsupportedWindowsExecutableMessage(),
  );
}

export function unsafeWindowsCommandShimError(): ClaudeCliConfigError {
  return new ClaudeCliConfigError("unsafe-windows-command-shim", unsafeWindowsCommandShimMessage());
}

export function windowsMcpConfigError(
  stage: ClaudeCliWindowsMcpConfigStage,
  cleanupFailure?: ClaudeCliWindowsMcpConfigError,
): ClaudeCliWindowsMcpConfigError {
  return new ClaudeCliWindowsMcpConfigError(
    stage === "cleanup" ? "windows-mcp-config-cleanup" : "windows-mcp-config-write",
    stage,
    windowsMcpConfigMessage(stage),
    cleanupFailure,
  );
}

export function notSignedInError(): ClaudeCliConfigError {
  return markProviderAuthFailure(new ClaudeCliConfigError("not-signed-in", NOT_SIGNED_IN_MESSAGE));
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
