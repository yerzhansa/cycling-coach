export const REFRESH_FAILURE_REASONS = [
  "reauth",
  "rate_limit",
  "server_error",
  "network",
  "unknown",
] as const;

export type RefreshFailureReason = (typeof REFRESH_FAILURE_REASONS)[number];

export interface RefreshFailure {
  readonly refreshFailureReason: RefreshFailureReason;
}

export function readRefreshFailureReason(value: unknown): RefreshFailureReason | null {
  if (value === null || typeof value !== "object" || !("refreshFailureReason" in value)) {
    return null;
  }
  const reason = value.refreshFailureReason;
  switch (reason) {
    case "reauth":
    case "rate_limit":
    case "server_error":
    case "network":
    case "unknown":
      return reason;
    default:
      return null;
  }
}

export class TokenRefreshError extends Error implements RefreshFailure {
  constructor(
    public readonly refreshFailureReason: RefreshFailureReason,
    cause?: unknown,
  ) {
    super("OAuth token refresh failed");
    this.name = "TokenRefreshError";
    this.cause = cause;
  }
}
