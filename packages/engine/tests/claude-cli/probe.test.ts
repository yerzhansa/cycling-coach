import { describe, expect, it, vi } from "vitest";
import type { AccountInfo, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCliRuntime } from "../../src/agent/claude-cli/env.js";
import { ClaudeCliConfigError } from "../../src/agent/claude-cli/errors.js";
import {
  API_KEY_BILLING_IDENTITY_LINE,
  claudeIdentityLine,
  classifyAccountInfo,
  ensureClaudeCliReady,
  probeClaudeAccount,
  readFallbackEmail,
  refusalForProbe,
} from "../../src/agent/claude-cli/probe.js";

const SENTINEL = "sk-ant-sentinel-probe-0000";

const RUNTIME: ClaudeCliRuntime = {
  binaryPath: "/Users/tester/.local/bin/claude",
  billing: "subscription",
};

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    ANTHROPIC_API_KEY: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
  };
}

interface FakeQueryState {
  calls: number;
  returns: number;
  lastOptions: Record<string, unknown> | null;
}

function makeQuery(
  account: AccountInfo | null,
  behaviour: { hang?: boolean; throwOnAccountInfo?: boolean } = {},
): { fn: typeof sdkQuery; state: FakeQueryState } {
  const state: FakeQueryState = { calls: 0, returns: 0, lastOptions: null };
  const fn = ((args: { prompt: unknown; options?: unknown }) => {
    state.calls += 1;
    state.lastOptions = (args.options ?? null) as Record<string, unknown> | null;
    const never = new Promise<never>(() => {});
    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      next: async () => ({ done: true as const, value: undefined }),
      return: async () => {
        state.returns += 1;
        return { done: true as const, value: undefined };
      },
      throw: async () => ({ done: true as const, value: undefined }),
      initializationResult: async () => {
        if (behaviour.hang === true) return never;
        return { account: account ?? undefined };
      },
      accountInfo: async () => {
        if (behaviour.hang === true) return never;
        if (behaviour.throwOnAccountInfo === true) throw new Error("no account channel");
        if (account === null) throw new Error("not logged in");
        return account;
      },
    };
    return q;
  }) as unknown as typeof sdkQuery;
  return { fn, state };
}

describe("classifyAccountInfo", () => {
  it("classifies a first-party subscription", () => {
    expect(
      classifyAccountInfo({
        email: "rider@example.test",
        subscriptionType: "Claude Max",
        apiProvider: "firstParty",
      }),
    ).toEqual({ accountClass: "subscription", email: "rider@example.test", plan: "Max" });
  });

  it.each(["apiKey", "ANTHROPIC_API_KEY", "anthropic-auth-token"])(
    "classifies tokenSource %s as api-key-token",
    (tokenSource) => {
      expect(classifyAccountInfo({ tokenSource, apiProvider: "firstParty" }).accountClass).toBe(
        "api-key-token",
      );
    },
  );

  it.each(["bedrock", "vertex", "foundry"] as const)(
    "classifies apiProvider %s as api-key-token",
    (apiProvider) => {
      expect(classifyAccountInfo({ subscriptionType: "Max", apiProvider }).accountClass).toBe(
        "api-key-token",
      );
    },
  );

  it.each([
    [{ tokenSource: "none", apiProvider: "firstParty" } as AccountInfo],
    [{ apiProvider: "firstParty" } as AccountInfo],
    [{ subscriptionType: "Max" } as AccountInfo],
    [{ subscriptionType: "Max", apiProvider: "gateway" } as AccountInfo],
    [null],
    [undefined],
  ])("fails closed to unrecognized for %j", (account) => {
    expect(classifyAccountInfo(account).accountClass).toBe("unrecognized");
  });
});

describe("identity lines", () => {
  it("renders the subscription line", () => {
    expect(
      claudeIdentityLine({
        verified: true,
        accountClass: "subscription",
        email: "rider@example.test",
        plan: "Pro",
      }),
    ).toBe("Signed in as rider@example.test - Claude Pro subscription");
  });

  it("drops the email when unavailable", () => {
    expect(claudeIdentityLine({ verified: true, accountClass: "subscription", plan: "Max" })).toBe(
      "Signed in - Claude Max subscription",
    );
  });

  it("never renders an undefined plan", () => {
    expect(
      claudeIdentityLine({
        verified: true,
        accountClass: "subscription",
        email: "rider@example.test",
      }),
    ).toBe("Signed in as rider@example.test");
  });

  it("renders the api-key billing line", () => {
    expect(claudeIdentityLine({ verified: true, accountClass: "api-key-token" })).toBe(
      API_KEY_BILLING_IDENTITY_LINE,
    );
  });
});

describe("readFallbackEmail", () => {
  it("extracts only the oauth email and discards the rest", async () => {
    const email = await readFallbackEmail("/tmp/cfg", {
      readFile: async () =>
        JSON.stringify({
          oauthAccount: { emailAddress: "rider@example.test", accountUuid: "abc" },
          customApiKeyResponses: { approved: [SENTINEL] },
        }),
    });
    expect(email).toBe("rider@example.test");
  });

  it("returns undefined on unreadable or malformed files", async () => {
    await expect(
      readFallbackEmail("/tmp/cfg", {
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFallbackEmail("/tmp/cfg", { readFile: async () => "{not json" }),
    ).resolves.toBeUndefined();
  });
});

describe("probeClaudeAccount", () => {
  it("verifies a logged-in subscription and closes the query", async () => {
    const { fn, state } = makeQuery({
      email: "rider@example.test",
      subscriptionType: "Claude Max",
      apiProvider: "firstParty",
    });
    const input = { runtime: RUNTIME, baseEnv: baseEnv() };
    const result = await probeClaudeAccount(input, { query: fn });
    expect(result).toMatchObject({
      verified: true,
      accountClass: "subscription",
      email: "rider@example.test",
      plan: "Max",
    });
    expect(state.returns).toBe(1);
  });

  it("builds sanitized options with an explicit executable and no tools", async () => {
    const { fn, state } = makeQuery({ tokenSource: "none", apiProvider: "firstParty" });
    await probeClaudeAccount({ runtime: RUNTIME, baseEnv: baseEnv() }, { query: fn });
    const options = state.lastOptions ?? {};
    expect(options.pathToClaudeCodeExecutable).toBe(RUNTIME.binaryPath);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(JSON.stringify(options.env)).not.toContain(SENTINEL);
  });

  it("reports no-account when the CLI is logged out", async () => {
    const { fn } = makeQuery(null, { throwOnAccountInfo: true });
    const input = { runtime: RUNTIME, baseEnv: baseEnv() };
    const result = await probeClaudeAccount(input, { query: fn });
    expect(result).toMatchObject({
      verified: false,
      accountClass: "unrecognized",
      reason: "no-account",
    });
  });

  it("retries once then collapses to a timeout", async () => {
    const { fn, state } = makeQuery(null, { hang: true });
    const sleep = vi.fn(async () => {});
    const result = await probeClaudeAccount(
      { runtime: RUNTIME, baseEnv: baseEnv(), timeoutMs: 5 },
      { query: fn, sleep },
    );
    expect(result).toMatchObject({
      verified: false,
      accountClass: "unrecognized",
      reason: "timeout",
    });
    expect(state.calls).toBe(2);
  });

  it("falls back to the config-dir email for display only", async () => {
    const { fn } = makeQuery({ subscriptionType: "Claude Pro", apiProvider: "firstParty" });
    const result = await probeClaudeAccount(
      { runtime: { ...RUNTIME, configDir: "/tmp/cfg" }, baseEnv: baseEnv() },
      { query: fn, readFallbackEmail: async () => "fallback@example.test" },
    );
    expect(result.email).toBe("fallback@example.test");
    expect(result.accountClass).toBe("subscription");
  });
});

describe("refusalForProbe", () => {
  it("passes a subscription result in subscription mode", () => {
    expect(
      refusalForProbe(
        { verified: true, accountClass: "subscription", plan: "Max" },
        "subscription",
      ),
    ).toBeNull();
  });

  it("refuses an api-key identity in subscription mode", () => {
    const refusal = refusalForProbe(
      { verified: true, accountClass: "api-key-token" },
      "subscription",
    );
    expect(refusal?.kind).toBe("api-key-identity");
  });

  it("refuses a subscription identity in api-key mode", () => {
    const refusal = refusalForProbe(
      { verified: true, accountClass: "subscription", plan: "Max" },
      "api-key",
    );
    expect(refusal?.kind).toBe("api-key-unapproved");
  });

  it("refuses an unrecognized auth source in both modes", () => {
    for (const billing of ["subscription", "api-key"] as const) {
      const refusal = refusalForProbe(
        { verified: false, accountClass: "unrecognized", rawAuthSource: "quantumAuth" },
        billing,
      );
      expect(refusal?.kind).toBe("unrecognized-auth-source");
      expect(refusal?.message).toContain("quantumAuth");
    }
  });

  it("maps timeout and no-account to their own messages", () => {
    expect(
      refusalForProbe(
        { verified: false, accountClass: "unrecognized", reason: "timeout" },
        "subscription",
      )?.kind,
    ).toBe("probe-timeout");
    expect(
      refusalForProbe(
        { verified: false, accountClass: "unrecognized", reason: "no-account" },
        "subscription",
      )?.kind,
    ).toBe("not-signed-in");
  });
});

describe("ensureClaudeCliReady", () => {
  const deps = {
    resolveBinary: async () => RUNTIME.binaryPath,
    probeVersion: async () => "9.9.9",
  };

  it("returns the identity line for a signed-in subscription", async () => {
    const readiness = await ensureClaudeCliReady(
      { baseEnv: baseEnv(), model: "haiku" },
      {
        ...deps,
        probeAccount: async () => ({
          verified: true,
          accountClass: "subscription" as const,
          email: "rider@example.test",
          plan: "Max",
        }),
      },
    );
    expect(readiness.identityLine).toBe(
      "Signed in as rider@example.test - Claude Max subscription",
    );
    expect(readiness.version).toBe("9.9.9");
  });

  it("refuses when the binary is absent", async () => {
    await expect(
      ensureClaudeCliReady({ baseEnv: baseEnv() }, { ...deps, resolveBinary: async () => null }),
    ).rejects.toMatchObject({ kind: "binary-missing" });
  });

  it("refuses below the version floor", async () => {
    await expect(
      ensureClaudeCliReady({ baseEnv: baseEnv() }, { ...deps, probeVersion: async () => "0.0.1" }),
    ).rejects.toMatchObject({ kind: "version-below-floor" });
  });

  it("refuses an unrecognized auth source before serving", async () => {
    const failure = await ensureClaudeCliReady(
      { baseEnv: baseEnv() },
      {
        ...deps,
        probeAccount: async () => ({
          verified: false,
          accountClass: "unrecognized" as const,
          rawAuthSource: "renamedField",
        }),
      },
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ClaudeCliConfigError);
    expect((failure as ClaudeCliConfigError).kind).toBe("unrecognized-auth-source");
  });
});
