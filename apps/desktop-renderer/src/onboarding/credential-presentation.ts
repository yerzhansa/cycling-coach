import type { ClaudeCliState } from "./constants.js";
import type { ClaudeCliStatus, CredentialSlotStatus } from "./machine.js";
import { PLATFORM_COPY } from "../platform-copy.js";

export const CLAUDE_CLI_API_KEY_IDENTITY =
  "Using Anthropic API key billing - usage is charged to your API account.";

export interface ClaudeCliPresentation {
  readonly runtimeState: "active" | "stored-inactive" | "failed";
  readonly badge: string;
  readonly detail: string | null;
}

const CLAUDE_CLI_PRESENTATION: Readonly<Record<ClaudeCliState, ClaudeCliPresentation>> = {
  ready: { runtimeState: "active", badge: "Signed in", detail: null },
  "ready-api-key": { runtimeState: "active", badge: "API key billing", detail: null },
  "absent-binary": {
    runtimeState: "failed",
    badge: "Not installed",
    detail:
      "Claude Code CLI was not found, or the installed version is too old. Install or update it, then choose Check again.",
  },
  "not-logged-in": {
    runtimeState: "failed",
    badge: "Not signed in",
    detail:
      "Claude Code CLI is not signed in. Open a terminal, run claude, and sign in with your Claude subscription. Enduragent never signs in for you.",
  },
  "api-key-token": {
    runtimeState: "failed",
    badge: "API key, not a subscription",
    detail:
      "Claude Code CLI is authenticated with an API key or token, not a subscription. Sign in with your subscription in claude, or opt in to API key billing in your configuration.",
  },
  disabled: {
    runtimeState: "stored-inactive",
    badge: "Turned off",
    detail: `The Claude subscription lane is turned off on ${PLATFORM_COPY.computer}. Choose another provider.`,
  },
  "working-area-unavailable": {
    runtimeState: "failed",
    badge: "Could not start safely",
    detail:
      "Enduragent could not prepare Claude's private working area. Restart Enduragent, then choose Check again.",
  },
};

const CLAUDE_CLI_UNKNOWN_PRESENTATION: ClaudeCliPresentation = {
  runtimeState: "stored-inactive",
  badge: "Checking",
  detail: `Checking the Claude Code CLI sign-in on ${PLATFORM_COPY.computer}…`,
};

export function claudeCliPresentation(state: ClaudeCliState | null): ClaudeCliPresentation {
  return state === null ? CLAUDE_CLI_UNKNOWN_PRESENTATION : CLAUDE_CLI_PRESENTATION[state];
}

export function claudeCliIdentityLine(status: ClaudeCliStatus): string | null {
  if (status.state === "ready-api-key") return CLAUDE_CLI_API_KEY_IDENTITY;
  if (status.state !== "ready") return null;
  const email = status.email?.trim() ?? "";
  const plan = status.plan?.trim() ?? "";
  if (plan.length === 0) return email.length === 0 ? "Signed in" : `Signed in as ${email}`;
  return email.length === 0
    ? `Signed in - Claude ${plan} subscription`
    : `Signed in as ${email} - Claude ${plan} subscription`;
}

export interface CredentialPresentation {
  readonly className: string;
  readonly copy: string;
  readonly retryable: boolean;
}

export function credentialPresentation(status: CredentialSlotStatus): CredentialPresentation {
  if (status.state === "missing") {
    return { className: "", copy: "Not configured", retryable: false };
  }
  if (status.state === "re-prompt") {
    return { className: "re-prompt", copy: "Enter again", retryable: false };
  }
  if (status.runtimeState === "active") {
    return { className: "configured", copy: "Configured", retryable: false };
  }
  if (status.runtimeState === "stored-inactive") {
    return { className: "stored-inactive", copy: "Saved · Not in use", retryable: false };
  }
  return { className: "failed", copy: "Saved · Retry", retryable: true };
}
