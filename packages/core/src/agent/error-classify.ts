import type { ApiError } from "intervals-icu-api";
import { classifyFailure, formatRateLimitWait, isRateLimitError } from "./token-utils.js";

export type AgentErrorKind =
  | "rate_limit"
  | "provider-auth"
  | "provider-down"
  | "intervals"
  | "unknown";

const INTERVALS_API_ERROR_KINDS: ReadonlySet<string> = new Set([
  "Unauthorized",
  "Forbidden",
  "NotFound",
  "RateLimit",
  "Validation",
  "Http",
  "Timeout",
  "Network",
  "Unknown",
]);

// Narrow guard: intervals' ApiError is a type-only discriminated union (no
// importable class), so match on its specific `kind` literals rather than any
// object that happens to carry a string `kind`, which would misclassify
// unrelated errors.
function isIntervalsApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string" &&
    INTERVALS_API_ERROR_KINDS.has((err as { kind: string }).kind)
  );
}

export function classifyAgentError(err: unknown): {
  kind: AgentErrorKind;
  athleteMessage: string;
} {
  if (isRateLimitError(err)) {
    return {
      kind: "rate_limit",
      athleteMessage: `Rate limited — please try again in ${formatRateLimitWait(err)}.`,
    };
  }

  if (isIntervalsApiError(err)) {
    if (err.kind === "RateLimit") {
      return {
        kind: "rate_limit",
        athleteMessage: `Rate limited — please try again in ${formatRateLimitWait(err)}.`,
      };
    }
    if (err.kind === "Timeout" || err.kind === "Network") {
      return {
        kind: "provider-down",
        athleteMessage: "The model provider is having trouble — try again in a few minutes.",
      };
    }
    return {
      kind: "intervals",
      athleteMessage: "Couldn't reach intervals.icu right now — try again shortly.",
    };
  }

  switch (classifyFailure(err)) {
    case "auth":
      return {
        kind: "provider-auth",
        athleteMessage:
          "The model provider rejected the API key — check your provider credentials.",
      };
    case "server_error":
    case "network":
    case "timeout":
      return {
        kind: "provider-down",
        athleteMessage: "The model provider is having trouble — try again in a few minutes.",
      };
    default:
      return {
        kind: "unknown",
        athleteMessage: "Sorry, something went wrong. Please try again.",
      };
  }
}
