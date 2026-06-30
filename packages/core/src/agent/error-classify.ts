import type { ApiError } from "intervals-icu-api";
import { classifyFailure, formatRateLimitWait, isRateLimitError } from "./token-utils.js";

export type AgentErrorKind =
  | "rate_limit"
  | "provider-auth"
  | "provider-down"
  | "intervals"
  | "unknown";

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
  Timeout: "provider-down",
  Network: "provider-down",
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

function rateLimited(err: unknown): { kind: AgentErrorKind; athleteMessage: string } {
  return {
    kind: "rate_limit",
    athleteMessage: `Rate limited — please try again in ${formatRateLimitWait(err)}.`,
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
    const routed = INTERVALS_KIND_ROUTING[err.kind];
    if (routed === "rate_limit") {
      return rateLimited(err);
    }
    if (routed === "provider-down") {
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
