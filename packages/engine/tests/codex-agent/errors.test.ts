import { describe, expect, it } from "vitest";

import {
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_WINDOWS_MESSAGE,
} from "@enduragent/coach-contract";

import {
  CODEX_OVERLOADED_CODE,
  CodexAgentConfigError,
  NOT_SIGNED_IN_MESSAGE,
  PROBE_TIMEOUT_MESSAGE,
  accountNotChatgptError,
  binaryMissingError,
  disabledLaneError,
  endpointNotPinnedError,
  mcpIsolationError,
  normalizeCodexAgentError,
  notSignedInError,
  overrideMismatchError,
  probeTimeoutError,
  redactSecretShapes,
  unsupportedPlatformError,
  versionBelowFloorError,
} from "../../src/agent/codex-agent/errors.js";
import { CodexProcessExitError, CodexRequestError } from "../../src/agent/codex-agent/protocol.js";
import { isProviderAuthFailure } from "../../src/provider-auth-failure.js";
import { classifyFailure } from "../../../core/src/agent/token-utils.js";

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K";
const SK_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx";
const BEARER_LINE = "authorization: Bearer ya29.a0AfB_byBIGSECRETVALUE";

function stderrTail(): string {
  return [
    `ERROR refresh failed with ${JWT}`,
    `ERROR sent ${BEARER_LINE}`,
    `ERROR fallback key ${SK_KEY}`,
  ].join("\n");
}

function expectNoTokens(text: string): void {
  expect(text).not.toContain(JWT);
  expect(text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  expect(text).not.toContain("ya29.a0AfB_byBIGSECRETVALUE");
  expect(text).not.toContain(SK_KEY);
}

describe("user-facing configuration messages", () => {
  it("names the binary, the login command and the config key when the CLI is missing", () => {
    const err = binaryMissingError("/opt/homebrew/bin/codex");
    expect(err.kind).toBe("binary-missing");
    expect(err.message).toBe(
      "Codex CLI not found at /opt/homebrew/bin/codex. Install it and run codex login, or set llm.codex_agent.binary_path. (Mac launchd users: set an absolute path like '/opt/homebrew/bin/codex'.)",
    );
  });

  it("names the Windows deferral before anything is spawned", () => {
    const err = unsupportedPlatformError();
    expect(err.kind).toBe("unsupported-platform");
    expect(err.message).toBe(CODEX_AGENT_WINDOWS_MESSAGE);
    expect(err.message).toContain("macOS and Linux only");
  });

  it("refuses the disabled lane with the message the startup gate prints", () => {
    const err = disabledLaneError();
    expect(err.kind).toBe("disabled");
    expect(err.message).toBe(CODEX_AGENT_DISABLED_MESSAGE);
    expect(err.message).toContain("llm.codex_agent.enabled: true");
  });

  it("advises the upgrade below the floor", () => {
    expect(versionBelowFloorError("0.45.9", "0.46.0").message).toBe(
      "Codex CLI 0.45.9 is older than the minimum supported 0.46.0. Update codex.",
    );
  });

  it("never offers to sign the athlete in", () => {
    expect(notSignedInError().message).toBe(NOT_SIGNED_IN_MESSAGE);
    expect(NOT_SIGNED_IN_MESSAGE).toContain("Enduragent never signs in for you");
  });

  it("keeps the readiness timeout distinct from being signed out", () => {
    expect(probeTimeoutError().message).toBe(PROBE_TIMEOUT_MESSAGE);
    expect(PROBE_TIMEOUT_MESSAGE).not.toBe(NOT_SIGNED_IN_MESSAGE);
  });

  it("names the offending auth type when the account is not a ChatGPT plan", () => {
    expect(accountNotChatgptError("apiKey").message).toBe(
      "Codex CLI is authenticated as 'apiKey', not a ChatGPT subscription. This lane requires a ChatGPT plan sign-in.",
    );
  });

  it("names the key that failed the safety read-back", () => {
    expect(overrideMismatchError("features.hooks").message).toBe(
      "Codex CLI refused a required safety setting (features.hooks). This machine's managed configuration is incompatible with the coaching lane.",
    );
  });

  it("names the key that redirected the model endpoint", () => {
    expect(endpointNotPinnedError("chatgpt_base_url").message).toBe(
      "Codex CLI is configured to route model requests to a custom endpoint (chatgpt_base_url). The coaching lane requires the default OpenAI/ChatGPT endpoint.",
    );
  });

  it("tells the operator where to fix an un-isolatable MCP configuration", () => {
    expect(mcpIsolationError("33 servers").message).toBe(
      "Cannot safely isolate the Codex MCP configuration on this machine (33 servers). Rename or disable the offending server in ~/.codex/config.toml, or choose another provider.",
    );
  });

  it("marks only the auth-class refusals as provider auth failures", () => {
    expect(isProviderAuthFailure(notSignedInError())).toBe(true);
    expect(isProviderAuthFailure(accountNotChatgptError("apiKey"))).toBe(true);
    for (const err of [
      binaryMissingError("/bin/codex"),
      unsupportedPlatformError(),
      versionBelowFloorError("0.45.9", "0.46.0"),
      probeTimeoutError(),
      overrideMismatchError("features.hooks"),
      endpointNotPinnedError("openai_base_url"),
      mcpIsolationError("alpha"),
    ]) {
      expect(isProviderAuthFailure(err), err.message).toBe(false);
    }
  });
});

describe("redactSecretShapes", () => {
  it("removes JWTs, bearer headers and sk- keys", () => {
    const redacted = redactSecretShapes(stderrTail());
    expectNoTokens(redacted);
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).toContain("ERROR refresh failed with");
  });

  it("is idempotent so a twice-redacted tail is unchanged", () => {
    const once = redactSecretShapes(stderrTail());
    expect(redactSecretShapes(once)).toBe(once);
  });

  it("leaves ordinary diagnostic text alone", () => {
    expect(redactSecretShapes("ERROR sqlite is busy")).toBe("ERROR sqlite is busy");
  });
});

describe("normalizeCodexAgentError", () => {
  it("passes a configuration error through untouched", () => {
    const err = binaryMissingError("/bin/codex");
    expect(normalizeCodexAgentError(err)).toBe(err);
  });

  it("preserves an abort shape", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(normalizeCodexAgentError(abort)).toBe(abort);
  });

  it("routes a mid-turn auth failure to the sign-in guidance", () => {
    for (const message of [
      "token expired",
      "not logged in",
      "invalid api key",
      "Request failed with status 401",
    ]) {
      const normalized = normalizeCodexAgentError(new Error(message));
      expect(normalized).toBeInstanceOf(CodexAgentConfigError);
      expect(normalized.message).toBe(NOT_SIGNED_IN_MESSAGE);
      expect(isProviderAuthFailure(normalized)).toBe(true);
      expect(classifyFailure(normalized)).toBe("auth");
    }
  });

  it("maps the app-server backpressure code to a retryable rate limit", () => {
    const overloaded = new CodexRequestError("turn/start", {
      code: CODEX_OVERLOADED_CODE,
      message: "Server overloaded; retry later.",
    });
    const normalized = normalizeCodexAgentError(overloaded);
    expect(normalized.name).toBe("RateLimitError");
    expect(normalized.message).toBe("Rate limit exceeded: Server overloaded; retry later.");
    expect(classifyFailure(normalized)).toBe("rate_limit");
  });

  it("carries retryAfterMs from the hint and from the message", () => {
    const hinted = normalizeCodexAgentError(
      new CodexRequestError("turn/start", {
        code: CODEX_OVERLOADED_CODE,
        message: "Server overloaded; retry later.",
      }),
      { retryAfterMs: 42_000 },
    );
    expect((hinted as Error & { retryAfterMs?: number }).retryAfterMs).toBe(42_000);

    const derived = normalizeCodexAgentError(new Error("rate limit; retry-after: 7"));
    expect(derived.name).toBe("RateLimitError");
    expect((derived as Error & { retryAfterMs?: number }).retryAfterMs).toBe(7_000);
  });

  it("maps a context failure to the overflow class the rescue path keys on", () => {
    const normalized = normalizeCodexAgentError(new Error("prompt is too long"));
    expect(normalized.name).toBe("ContextOverflowError");
    expect(normalized.message).toBe("Context overflow: prompt is too long");
    expect(classifyFailure(normalized)).toBe("overflow");
  });

  it("maps a stall to the timeout class", () => {
    expect(classifyFailure(normalizeCodexAgentError(new Error("stream stalled")))).toBe("timeout");
    expect(normalizeCodexAgentError(new Error("request timed out")).name).toBe("TimeoutError");
  });

  it("maps a child exit to the network class rather than a timeout", () => {
    const exit = new CodexProcessExitError({ code: 137, signal: null }, "");
    const normalized = normalizeCodexAgentError(exit);
    expect(normalized.name).toBe("NetworkError");
    expect(normalized.message).toContain("code 137");
    expect((normalized as Error & { cause?: unknown }).cause).toBe(exit);
    expect(classifyFailure(normalized)).toBe("network");
  });

  it("maps a broken pipe errno to the network class", () => {
    const piped = Object.assign(new Error("write failed"), { code: "EPIPE" });
    expect(classifyFailure(normalizeCodexAgentError(piped))).toBe("network");
  });

  it("maps a turn failure with an unclassifiable message to the server class on request", () => {
    const normalized = normalizeCodexAgentError(new Error("the turn did not produce a reply"), {
      fallback: "server-error",
    });
    expect(normalized.name).toBe("ServerError");
    expect(classifyFailure(normalized)).toBe("server_error");
  });

  it("maps an explicit 5xx text to the server class without a hint", () => {
    expect(classifyFailure(normalizeCodexAgentError(new Error("503 service unavailable")))).toBe(
      "server_error",
    );
  });

  it("folds a hint message into classification", () => {
    const normalized = normalizeCodexAgentError(new Error("codex reported a failed turn"), {
      message: "prompt is too long",
    });
    expect(normalized.name).toBe("ContextOverflowError");
  });

  it("leaves an unrecognized error alone", () => {
    const err = new Error("something unclassifiable");
    expect(normalizeCodexAgentError(err)).toBe(err);
  });
});

describe("stderr redaction through the whole error path", () => {
  it("redacts a token-bearing tail before it reaches a normalized message", () => {
    const exit = new CodexProcessExitError({ code: 1, signal: null }, stderrTail());
    const normalized = normalizeCodexAgentError(exit);
    expect(normalized.name).toBe("NetworkError");
    expect(normalized.message).toContain("[redacted]");
    expectNoTokens(normalized.message);
  });

  it("redacts a token-bearing tail folded in as a hint", () => {
    const normalized = normalizeCodexAgentError(new Error("codex exited with code 1"), {
      message: stderrTail(),
    });
    expect(normalized.message).toContain("[redacted]");
    expectNoTokens(normalized.message);
  });

  it("redacts a token-bearing tail on an otherwise unclassifiable failure", () => {
    const normalized = normalizeCodexAgentError(new Error(`codex said ${JWT}`));
    expect(normalized.message).toContain("[redacted]");
    expectNoTokens(normalized.message);
  });

  it("redacts a token-bearing tail on the rate-limit path", () => {
    const normalized = normalizeCodexAgentError(
      new CodexRequestError("turn/start", {
        code: CODEX_OVERLOADED_CODE,
        message: `Server overloaded; retry later. ${SK_KEY}`,
      }),
    );
    expect(normalized.message).toContain("Rate limit exceeded:");
    expectNoTokens(normalized.message);
  });
});
