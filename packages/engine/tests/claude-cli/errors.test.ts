import { describe, expect, it } from "vitest";

import {
  API_KEY_IDENTITY_MESSAGE,
  API_KEY_UNAPPROVED_MESSAGE,
  ClaudeCliConfigError,
  NOT_SIGNED_IN_MESSAGE,
  PROBE_TIMEOUT_MESSAGE,
  apiKeyIdentityError,
  apiKeyUnapprovedError,
  binaryMissingError,
  normalizeClaudeCliError,
  notSignedInError,
  probeTimeoutError,
  unrecognizedAuthSourceError,
  versionBelowFloorError,
} from "../../src/agent/claude-cli/errors.js";
import { isProviderAuthFailure } from "../../src/provider-auth-failure.js";

describe("user-facing configuration messages", () => {
  it("names the binary, the install page and the config key when the CLI is missing", () => {
    const err = binaryMissingError("/opt/homebrew/bin/claude");
    expect(err.kind).toBe("binary-missing");
    expect(err.message).toBe(
      "Claude Code CLI not found at /opt/homebrew/bin/claude. Install it (https://claude.com/claude-code) or set llm.claude_cli.binary_path. (Mac launchd users: set an absolute path like '/opt/homebrew/bin/claude'.)",
    );
  });

  it("advises the upgrade command below the floor", () => {
    expect(versionBelowFloorError("2.0.1", "2.1.220").message).toBe(
      "Claude Code CLI 2.0.1 is older than the minimum supported 2.1.220. Run: claude update",
    );
  });

  it("never offers to sign the athlete in", () => {
    expect(notSignedInError().message).toBe(
      "Claude Code CLI is not signed in. Open a terminal, run claude, and sign in with your Claude subscription. Enduragent never signs in for you.",
    );
  });

  it("keeps the probe timeout distinct from being signed out", () => {
    expect(probeTimeoutError().message).toBe(
      "Claude Code CLI account probe timed out. Retry, or check that claude starts in your terminal.",
    );
    expect(PROBE_TIMEOUT_MESSAGE).not.toBe(NOT_SIGNED_IN_MESSAGE);
  });

  it("explains the api-key identity refusal and the opt-in", () => {
    expect(apiKeyIdentityError().message).toBe(
      "Claude Code CLI is authenticated with an API key/token, not a subscription. Sign in with your subscription in claude, or set llm.claude_cli.billing: api-key to opt in to API billing.",
    );
    expect(API_KEY_IDENTITY_MESSAGE).toContain("llm.claude_cli.billing: api-key");
  });

  it("quotes the raw value on an unrecognized auth source", () => {
    expect(unrecognizedAuthSourceError("quantumToken").message).toBe(
      "Unrecognized Claude CLI auth source 'quantumToken' — update enduragent, or opt in with llm.claude_cli.billing: api-key.",
    );
  });

  it("explains the unapproved-key refusal in api-key mode", () => {
    expect(apiKeyUnapprovedError().message).toBe(
      "Your API key is not approved in the Claude CLI — run claude once with it and approve, or set llm.claude_cli.billing: subscription.",
    );
    expect(API_KEY_UNAPPROVED_MESSAGE).toContain("llm.claude_cli.billing: subscription");
  });
});

describe("normalizeClaudeCliError", () => {
  it("passes a configuration error through untouched", () => {
    const err = binaryMissingError("/bin/claude");
    expect(normalizeClaudeCliError(err)).toBe(err);
  });

  it("preserves an abort shape", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(normalizeClaudeCliError(abort)).toBe(abort);
  });

  it("routes a mid-stream auth failure to the sign-in guidance without retries", () => {
    for (const message of [
      "OAuth token expired",
      "Please run /login",
      "invalid api key",
      "Request failed with status 401",
    ]) {
      const normalized = normalizeClaudeCliError(new Error(message));
      expect(normalized).toBeInstanceOf(ClaudeCliConfigError);
      expect(normalized.message).toBe(NOT_SIGNED_IN_MESSAGE);
      expect(isProviderAuthFailure(normalized)).toBe(true);
    }
  });

  it("marks only the sign-in refusal as a provider auth failure", () => {
    expect(isProviderAuthFailure(notSignedInError())).toBe(true);
    for (const err of [
      binaryMissingError("/bin/claude"),
      versionBelowFloorError("2.0.1", "2.1.220"),
      probeTimeoutError(),
      apiKeyIdentityError(),
      apiKeyUnapprovedError(),
      unrecognizedAuthSourceError("quantumToken"),
      normalizeClaudeCliError(new Error("usage limit reached")),
      normalizeClaudeCliError(new Error("prompt is too long")),
    ]) {
      expect(isProviderAuthFailure(err), err.message).toBe(false);
    }
  });

  it("maps rate limits and carries retryAfterMs", () => {
    const normalized = normalizeClaudeCliError(new Error("usage limit reached"), {
      retryAfterMs: 42_000,
    });
    expect(normalized.name).toBe("RateLimitError");
    expect((normalized as Error & { retryAfterMs?: number }).retryAfterMs).toBe(42_000);
  });

  it("derives retryAfterMs from the message when the carrier has none", () => {
    const normalized = normalizeClaudeCliError(new Error("rate limit; retry-after: 7"));
    expect(normalized.name).toBe("RateLimitError");
    expect((normalized as Error & { retryAfterMs?: number }).retryAfterMs).toBe(7_000);
  });

  it("maps a too-long prompt to the overflow class", () => {
    const normalized = normalizeClaudeCliError(new Error("prompt is too long"));
    expect(normalized.name).toBe("ContextOverflowError");
  });

  it("maps a stall to the timeout class", () => {
    expect(normalizeClaudeCliError(new Error("stream stalled")).name).toBe("TimeoutError");
    expect(normalizeClaudeCliError(new Error("request timed out")).name).toBe("TimeoutError");
  });

  it("maps subprocess death to the network class with the cause chain intact", () => {
    const dead = new Error("process exited with code 137");
    const normalized = normalizeClaudeCliError(dead);
    expect(normalized.name).toBe("NetworkError");
    expect((normalized as Error & { cause?: unknown }).cause).toBe(dead);
  });

  it("maps a broken pipe errno to the network class", () => {
    const piped = Object.assign(new Error("write failed"), { code: "EPIPE" });
    expect(normalizeClaudeCliError(piped).name).toBe("NetworkError");
  });

  it("maps an execution error to the server class", () => {
    expect(normalizeClaudeCliError(new Error("error_during_execution")).name).toBe("ServerError");
  });

  it("folds the result-frame text into classification", () => {
    const normalized = normalizeClaudeCliError(new Error("Claude Code returned an error result"), {
      message: "Reached usage limit",
    });
    expect(normalized.name).toBe("RateLimitError");
  });

  it("leaves an unrecognized error alone", () => {
    const err = new Error("something unclassifiable");
    expect(normalizeClaudeCliError(err)).toBe(err);
  });
});
