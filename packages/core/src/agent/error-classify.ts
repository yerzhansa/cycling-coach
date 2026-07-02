import type { ApiError } from "intervals-icu-api";
import {
  classifyFailure,
  extractRetryAfterMs,
  formatRateLimitWaitMs,
  isRateLimitError,
} from "./token-utils.js";

export type AgentErrorKind =
  | "rate_limit"
  | "provider-auth"
  | "provider-down"
  | "intervals"
  | "unknown";

const PROVIDER_DOWN_MESSAGE =
  "The model provider is having trouble — try again in a few minutes.";
const INTERVALS_TRANSIENT_MESSAGE =
  "Couldn't reach intervals.icu right now — try again shortly.";
const INTERVALS_CREDENTIALS_MESSAGE =
  "intervals.icu rejected the request — check your intervals.icu connection or API key.";

// Routing for intervals' ApiError, whose `kind` is a type-only discriminated
// union (no importable class) we mirror here. The `satisfies Record<ApiError
// ["kind"], …>` tie makes `pnpm check` fail if the upstream union gains or
// renames a kind, forcing a routing decision instead of silently degrading to
// the generic apology.
const INTERVALS_KIND_ROUTING = {
  Unauthorized: "intervals",
  Forbidden: "intervals",
  NotFound: "intervals",
  Validation: "intervals",
  Http: "intervals",
  Unknown: "intervals",
  RateLimit: "rate_limit",
  Timeout: "intervals",
  Network: "intervals",
} satisfies Record<ApiError["kind"], AgentErrorKind>;

// Narrow guard: match only objects whose string `kind` is one the upstream
// union actually defines, so unrelated errors that happen to carry a `kind`
// are not misclassified as intervals failures.
function isIntervalsApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string" &&
    (err as { kind: string }).kind in INTERVALS_KIND_ROUTING
  );
}

function carriedRetryAfterMs(err: unknown): number | null {
  const carried = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof carried === "number" && Number.isFinite(carried) && carried > 0 ? carried : null;
}

function rateLimited(err: unknown): { kind: AgentErrorKind; athleteMessage: string } {
  const ms = extractRetryAfterMs(err) ?? carriedRetryAfterMs(err);
  return {
    kind: "rate_limit",
    athleteMessage: `Rate limited — please try again in ${formatRateLimitWaitMs(ms)}.`,
  };
}

export function classifyAgentError(err: unknown): {
  kind: AgentErrorKind;
  athleteMessage: string;
} {
  if (isRateLimitError(err)) {
    return rateLimited(err);
  }

  if (isIntervalsApiError(err)) {
    if (INTERVALS_KIND_ROUTING[err.kind] === "rate_limit") {
      return rateLimited(err);
    }
    if (err.kind === "Unauthorized" || err.kind === "Forbidden") {
      return {
        kind: "intervals",
        athleteMessage: INTERVALS_CREDENTIALS_MESSAGE,
      };
    }
    return {
      kind: "intervals",
      athleteMessage: INTERVALS_TRANSIENT_MESSAGE,
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
        athleteMessage: PROVIDER_DOWN_MESSAGE,
      };
    default:
      return {
        kind: "unknown",
        athleteMessage: "Sorry, something went wrong. Please try again.",
      };
  }
}
