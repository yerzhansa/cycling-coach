import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountInfo, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCliRuntime } from "../../src/agent/claude-cli/env.js";
import { ClaudeCliConfigError } from "../../src/agent/claude-cli/errors.js";
import {
  ACCOUNT_PROBE_CACHE_TTL_MS,
  API_KEY_BILLING_IDENTITY_LINE,
  claudeAccountProbeCacheKey,
  claudeIdentityLine,
  classifyAccountInfo,
  ensureClaudeCliReady,
  invalidateClaudeAccountProbeCache,
  probeClaudeAccount,
  probeClaudeAccountCached,
  readFallbackEmail,
  recheckClaudeAccount,
  refusalForProbe,
} from "../../src/agent/claude-cli/probe.js";
import { createScriptedQuery } from "./helpers/frame-script.js";

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

afterEach(() => {
  invalidateClaudeAccountProbeCache();
  vi.restoreAllMocks();
});

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
    [{ tokenSource: "NONE" } as AccountInfo],
  ])("classifies the signed-out shape %j as not-signed-in", (account) => {
    expect(classifyAccountInfo(account).accountClass).toBe("not-signed-in");
  });

  it.each([
    [{ apiProvider: "firstParty" } as AccountInfo],
    [{ subscriptionType: "Max" } as AccountInfo],
    [{ subscriptionType: "Max", apiProvider: "gateway" } as AccountInfo],
    [{ tokenSource: "quantumBadge", apiProvider: "firstParty" } as AccountInfo],
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

  it("reports a signed-out CLI as not-signed-in rather than an unknown auth source", async () => {
    const { fn } = makeQuery({ tokenSource: "none", apiProvider: "firstParty" });
    const result = await probeClaudeAccount(
      { runtime: RUNTIME, baseEnv: baseEnv() },
      { query: fn, readFallbackEmail: async () => undefined },
    );
    expect(result).toMatchObject({
      verified: false,
      accountClass: "not-signed-in",
      reason: "no-account",
    });
    const refused = refusalForProbe(result, "subscription");
    expect(refused?.kind).toBe("not-signed-in");
    expect(refused?.message).toContain("Open a terminal, run claude, and sign in");
  });

  it("returns instead of throwing when option construction fails synchronously", async () => {
    const { fn, state } = makeQuery({ subscriptionType: "Claude Max", apiProvider: "firstParty" });
    const result = await probeClaudeAccount(
      { runtime: { ...RUNTIME, binaryPath: "" }, baseEnv: baseEnv(), timeoutMs: 5 },
      { query: fn, sleep: vi.fn(async () => {}), readFallbackEmail: async () => undefined },
    );
    expect(result).toMatchObject({
      verified: false,
      accountClass: "unrecognized",
      reason: "no-account",
    });
    expect(state.calls).toBe(0);
  });

  it("returns instead of throwing when the sdk query throws synchronously", async () => {
    const throwing = (() => {
      throw new Error("spawn EACCES");
    }) as unknown as typeof sdkQuery;
    const result = await probeClaudeAccount(
      { runtime: RUNTIME, baseEnv: baseEnv(), timeoutMs: 5 },
      { query: throwing, sleep: vi.fn(async () => {}), readFallbackEmail: async () => undefined },
    );
    expect(result).toMatchObject({
      verified: false,
      accountClass: "unrecognized",
      reason: "no-account",
    });
    expect(refusalForProbe(result, "subscription")?.kind).toBe("not-signed-in");
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

  it("refuses a signed-out account with the sign-in message in both modes", () => {
    for (const billing of ["subscription", "api-key"] as const) {
      const refusal = refusalForProbe(
        {
          verified: false,
          accountClass: "not-signed-in",
          reason: "no-account",
          rawAuthSource: "none",
        },
        billing,
      );
      expect(refusal?.kind).toBe("not-signed-in");
      expect(refusal?.message).not.toContain("Unrecognized Claude CLI auth source");
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

describe("probe fixtures through the fake-CLI harness", () => {
  const cases = [
    {
      script: "probe-subscription",
      billing: "subscription" as const,
      accountClass: "subscription" as const,
      verified: true,
      refusal: null,
      identityLine: "Signed in as rider@example.test - Claude Max subscription",
    },
    {
      script: "probe-apikey",
      billing: "subscription" as const,
      accountClass: "api-key-token" as const,
      verified: true,
      refusal: "api-key-identity",
      identityLine: API_KEY_BILLING_IDENTITY_LINE,
    },
    {
      script: "probe-unknown-tokensource",
      billing: "subscription" as const,
      accountClass: "unrecognized" as const,
      verified: false,
      refusal: "unrecognized-auth-source",
      identityLine: null,
    },
    {
      script: "probe-missing-account",
      billing: "subscription" as const,
      accountClass: "unrecognized" as const,
      verified: false,
      refusal: "not-signed-in",
      identityLine: null,
    },
    {
      script: "probe-signed-out",
      billing: "subscription" as const,
      accountClass: "not-signed-in" as const,
      verified: false,
      refusal: "not-signed-in",
      identityLine: null,
    },
    {
      script: "probe-signed-out",
      billing: "api-key" as const,
      accountClass: "not-signed-in" as const,
      verified: false,
      refusal: "not-signed-in",
      identityLine: null,
    },
    {
      script: "probe-apikey-unapproved",
      billing: "api-key" as const,
      accountClass: "subscription" as const,
      verified: true,
      refusal: "api-key-unapproved",
      identityLine: null,
    },
    {
      script: "probe-apikey",
      billing: "api-key" as const,
      accountClass: "api-key-token" as const,
      verified: true,
      refusal: null,
      identityLine: API_KEY_BILLING_IDENTITY_LINE,
    },
  ];

  it.each(cases)(
    "classifies $script under $billing billing",
    async ({ script, billing, accountClass, verified, refusal, identityLine }) => {
      const scripted = createScriptedQuery([script]);
      const result = await probeClaudeAccount(
        { runtime: { ...RUNTIME, billing }, baseEnv: baseEnv() },
        { query: scripted.query, readFallbackEmail: async () => undefined },
      );
      expect(result.verified).toBe(verified);
      expect(result.accountClass).toBe(accountClass);
      const refused = refusalForProbe(result, billing);
      expect(refused?.kind ?? null).toBe(refusal);
      if (identityLine !== null && refused === null) {
        expect(claudeIdentityLine(result)).toBe(identityLine);
      }
    },
  );

  it("collapses a never-initializing CLI to the distinct probe-timeout message", async () => {
    const scripted = createScriptedQuery(["never-init"]);
    const sleep = vi.fn(async () => {});
    const result = await probeClaudeAccount(
      { runtime: RUNTIME, baseEnv: baseEnv(), timeoutMs: 5 },
      { query: scripted.query, sleep, readFallbackEmail: async () => undefined },
    );
    expect(result).toMatchObject({ verified: false, reason: "timeout" });
    expect(scripted.state.calls).toBe(2);
    const refused = refusalForProbe(result, "subscription");
    expect(refused?.kind).toBe("probe-timeout");
    expect(refused?.message).toContain("probe timed out");
    expect(refused?.message).not.toContain("not signed in");
  });
});

describe("probe cache", () => {
  const cacheDeps = (scripted: ReturnType<typeof createScriptedQuery>, clock: { ms: number }) => ({
    query: scripted.query,
    readFallbackEmail: async () => undefined,
    now: () => clock.ms,
  });

  it("keys on binary path, config dir and cwd", () => {
    expect(claudeAccountProbeCacheKey({ runtime: RUNTIME, cwd: "/work" })).toBe(
      `${RUNTIME.binaryPath}\0\0/work`,
    );
    expect(
      claudeAccountProbeCacheKey({
        runtime: { ...RUNTIME, configDir: "/cfg" },
        cwd: "/work",
      }),
    ).toBe(`${RUNTIME.binaryPath}\0/cfg\0/work`);
  });

  it("serves a second identical probe from the single slot", async () => {
    const scripted = createScriptedQuery(["probe-subscription"]);
    const clock = { ms: 1_000 };
    const input = { runtime: RUNTIME, baseEnv: baseEnv(), cwd: "/work" };
    const first = await probeClaudeAccountCached(input, cacheDeps(scripted, clock));
    const second = await probeClaudeAccountCached(input, cacheDeps(scripted, clock));
    expect(scripted.state.calls).toBe(1);
    expect(second).toBe(first);
  });

  it("re-probes for a different config dir and holds capacity one", async () => {
    const scripted = createScriptedQuery(["probe-subscription"]);
    const clock = { ms: 1_000 };
    const a = { runtime: RUNTIME, baseEnv: baseEnv(), cwd: "/work" };
    const b = { runtime: { ...RUNTIME, configDir: "/other" }, baseEnv: baseEnv(), cwd: "/work" };
    await probeClaudeAccountCached(a, cacheDeps(scripted, clock));
    await probeClaudeAccountCached(b, cacheDeps(scripted, clock));
    await probeClaudeAccountCached(a, cacheDeps(scripted, clock));
    expect(scripted.state.calls).toBe(3);
  });

  it("re-probes once the five-minute ttl expires", async () => {
    const scripted = createScriptedQuery(["probe-subscription"]);
    const clock = { ms: 1_000 };
    const input = { runtime: RUNTIME, baseEnv: baseEnv(), cwd: "/work" };
    await probeClaudeAccountCached(input, cacheDeps(scripted, clock));
    clock.ms += ACCOUNT_PROBE_CACHE_TTL_MS - 1;
    await probeClaudeAccountCached(input, cacheDeps(scripted, clock));
    expect(scripted.state.calls).toBe(1);
    clock.ms += 1;
    await probeClaudeAccountCached(input, cacheDeps(scripted, clock));
    expect(scripted.state.calls).toBe(2);
  });

  it("busts the slot on an explicit recheck", async () => {
    const scripted = createScriptedQuery(["probe-subscription"]);
    const clock = { ms: 1_000 };
    const input = { runtime: RUNTIME, baseEnv: baseEnv(), cwd: "/work" };
    await probeClaudeAccountCached(input, cacheDeps(scripted, clock));
    await recheckClaudeAccount(input, cacheDeps(scripted, clock));
    expect(scripted.state.calls).toBe(2);
  });
});

describe("fallback email confidentiality", () => {
  it("never lets the parsed config object reach a log sink", async () => {
    const sinks = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const email = await readFallbackEmail("/tmp/cfg", {
      readFile: async () =>
        JSON.stringify({
          oauthAccount: { emailAddress: "rider@example.test" },
          customApiKeyResponses: { approved: [SENTINEL] },
          primaryApiKey: SENTINEL,
        }),
    });

    expect(email).toBe("rider@example.test");
    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
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
