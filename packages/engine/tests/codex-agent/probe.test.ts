import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexAgentConfigError } from "../../src/agent/codex-agent/errors.js";
import {
  CODEX_PROBE_CACHE_TTL_MS,
  codexIdentityLine,
  codexPlanLabel,
  ensureCodexAgentReady,
  invalidateCodexAgentProbeCache,
  type CodexAgentReadinessResult,
  type EnsureCodexAgentReadyDeps,
} from "../../src/agent/codex-agent/probe.js";
import { createFakeCodex, type FakeCodex } from "./helpers/fake-codex.js";

const TEST_TIMEOUT_MS = 30_000;
const MODEL = "gpt-5.6-sol";

let fake: FakeCodex | null = null;
let warnings: string[] = [];

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
}

function deps(extra: EnsureCodexAgentReadyDeps = {}): EnsureCodexAgentReadyDeps {
  return { log: (line: string) => warnings.push(line), ...extra };
}

async function stage(script: string, version?: string): Promise<FakeCodex> {
  const staged = await createFakeCodex(version === undefined ? { script } : { script, version });
  fake = staged;
  return staged;
}

async function probe(
  staged: FakeCodex,
  overrides: { model?: string; timeoutMs?: number; forceRefresh?: boolean } = {},
  extraDeps: EnsureCodexAgentReadyDeps = {},
): Promise<CodexAgentReadinessResult> {
  return await ensureCodexAgentReady(
    {
      binaryPath: staged.binaryPath,
      model: overrides.model ?? MODEL,
      baseEnv: baseEnv(),
      ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
      ...(overrides.forceRefresh === undefined ? {} : { forceRefresh: overrides.forceRefresh }),
    },
    deps(extraDeps),
  );
}

function refusalKind(result: CodexAgentReadinessResult): string {
  if (result.status !== "refused") return "<ready>";
  return result.error instanceof CodexAgentConfigError ? result.error.kind : result.error.name;
}

beforeEach(() => {
  invalidateCodexAgentProbeCache();
  warnings = [];
});

afterEach(async () => {
  invalidateCodexAgentProbeCache();
  await fake?.cleanup();
  fake = null;
});

describe("ensureCodexAgentReady census", () => {
  it(
    "reports a signed-in ChatGPT account, the model list and the foreign server names",
    async () => {
      const staged = await stage("probe-ready");
      const result = await probe(staged);

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.binaryPath).toBe(staged.binaryPath);
      expect(result.version).toBe("0.146.0");
      expect(result.account).toEqual({
        type: "chatgpt",
        email: "athlete@example.test",
        planType: "pro",
      });
      expect(result.identityLine).toBe("Signed in as athlete@example.test - ChatGPT Pro plan");
      expect(result.foreignServers).toEqual(["alpha", "beta"]);
      expect(result.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
      expect(result.warnings).toEqual([]);
      expect(warnings).toEqual([]);

      const frames = await staged.readFramesIn(1);
      const methods = frames.map((frame) => frame.method);
      expect(methods.slice(0, 2)).toEqual(["initialize", "initialized"]);
      expect(methods.slice(2).sort()).toEqual(["account/read", "config/read", "model/list"]);
      expect(frames.find((frame) => frame.method === "config/read")?.params).toEqual({
        includeLayers: false,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "spawns the census with the fixed override set and no tool endpoint of ours (AC-7)",
    async () => {
      const staged = await stage("probe-ready");
      expect((await probe(staged)).status).toBe("ready");

      const argv = await staged.readArgv(1);
      expect(argv[0]).toBe("app-server");
      for (const expected of [
        'approval_policy="never"',
        'sandbox_mode="read-only"',
        'web_search="disabled"',
        'model_provider="openai"',
        'openai_base_url=""',
        "agents.enabled=false",
        "features.shell_tool=false",
        "features.unified_exec=false",
        "features.multi_agent=false",
        "features.multi_agent_v2=false",
        "features.hooks=false",
      ]) {
        expect(argv, expected).toContain(expected);
      }
      expect(argv.some((entry) => entry.startsWith("mcp_servers.enduragent"))).toBe(false);
      expect(
        argv.some((entry) => entry.includes(".enabled=false") && entry.startsWith("mcp_servers")),
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("ensureCodexAgentReady account classification (AC-18)", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ["probe-account-apikey", "account-not-chatgpt", "'apiKey'"],
    ["probe-account-bedrock", "account-not-chatgpt", "'amazonBedrock'"],
    ["probe-account-personal-access-token", "account-not-chatgpt", "'personalAccessToken'"],
  ];

  for (const [script, kind, fragment] of cases) {
    it(
      `refuses ${script}`,
      async () => {
        const staged = await stage(script);
        const result = await probe(staged);

        expect(refusalKind(result)).toBe(kind);
        if (result.status !== "refused") return;
        expect(result.error.message).toContain(fragment);
        expect(result.error.message).toContain("ChatGPT plan sign-in");
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "refuses a null account with the sign-in message",
    async () => {
      const staged = await stage("probe-account-null");
      const result = await probe(staged);

      expect(refusalKind(result)).toBe("not-signed-in");
      if (result.status !== "refused") return;
      expect(result.error.message).toContain("codex login");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders the identity line without an email and never prints an undefined plan",
    async () => {
      const noEmail = await stage("probe-account-no-email");
      const first = await probe(noEmail);
      expect(first.status).toBe("ready");
      if (first.status === "ready") {
        expect(first.identityLine).toBe("Signed in - ChatGPT Pro Lite plan");
      }
      await noEmail.cleanup();
      invalidateCodexAgentProbeCache();

      const unknownPlan = await stage("probe-account-unknown-plan");
      const second = await probe(unknownPlan);
      expect(second.status).toBe("ready");
      if (second.status !== "ready") return;
      expect(second.identityLine).toBe("Signed in as athlete@example.test - ChatGPT plan");
      expect(second.identityLine).not.toContain("undefined");
    },
    TEST_TIMEOUT_MS,
  );

  it("title-cases every documented plan type and drops the unknown sentinel", () => {
    expect(codexPlanLabel("plus")).toBe("Plus");
    expect(codexPlanLabel("prolite")).toBe("Pro Lite");
    expect(codexPlanLabel("self_serve_business_usage_based")).toBe("Business");
    expect(codexPlanLabel("enterprise_cbp_usage_based")).toBe("Enterprise");
    expect(codexPlanLabel("edu")).toBe("Edu");
    expect(codexPlanLabel("unknown")).toBeNull();
    expect(codexPlanLabel("")).toBeNull();
    expect(codexPlanLabel("future_tier")).toBe("Future Tier");
    expect(codexIdentityLine({ type: "chatgpt", email: null, planType: "unknown" })).toBe(
      "Signed in - ChatGPT plan",
    );
  });
});

describe("ensureCodexAgentReady override read-back (AC-7)", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ["probe-override-mismatch", "override-mismatch", "sandbox_mode"],
    ["probe-override-missing-key", "override-mismatch", "features.hooks"],
    ["probe-custom-provider", "endpoint-not-pinned", "model_provider"],
    ["probe-openai-base-url", "endpoint-not-pinned", "openai_base_url"],
    ["probe-foreign-chatgpt-base-url", "endpoint-not-pinned", "chatgpt_base_url"],
  ];

  for (const [script, kind, key] of cases) {
    it(
      `refuses ${script}`,
      async () => {
        const staged = await stage(script);
        const result = await probe(staged);

        expect(refusalKind(result)).toBe(kind);
        if (result.status !== "refused") return;
        expect(result.error.message).toContain(key);
      },
      TEST_TIMEOUT_MS,
    );
  }
});

describe("ensureCodexAgentReady census guards (AC-8)", () => {
  const illegal = [
    "probe-illegal-name-dot",
    "probe-illegal-name-space",
    "probe-illegal-name-equals",
    "probe-illegal-name-quote",
  ];

  for (const script of illegal) {
    it(
      `refuses an MCP server name that cannot be disabled (${script})`,
      async () => {
        const staged = await stage(script);
        const result = await probe(staged);

        expect(refusalKind(result)).toBe("mcp-isolation");
        if (result.status !== "refused") return;
        expect(result.error.message).toContain("cannot be safely disabled");
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "refuses a user-defined server that collides with our endpoint name",
    async () => {
      const staged = await stage("probe-enduragent-collision");
      const result = await probe(staged);

      expect(refusalKind(result)).toBe("mcp-isolation");
      if (result.status !== "refused") return;
      expect(result.error.message).toContain("already named 'enduragent'");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses more foreign servers than the supported maximum",
    async () => {
      const staged = await stage("probe-33-servers");
      const result = await probe(staged);

      expect(refusalKind(result)).toBe("mcp-isolation");
      if (result.status !== "refused") return;
      expect(result.error.message).toContain("33 MCP servers");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("ensureCodexAgentReady version and model posture (AC-24)", () => {
  it(
    "refuses a binary below the version floor before spawning an app-server",
    async () => {
      const staged = await stage("probe-ready", "0.45.9");
      const result = await probe(staged);

      expect(refusalKind(result)).toBe("version-below-floor");
      if (result.status === "refused") {
        expect(result.error.message).toContain("0.46.0");
      }
      expect(await staged.spawnCount()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts at the floor exactly",
    async () => {
      const staged = await stage("probe-ready", "0.46.0");
      const result = await probe(staged);
      expect(result.status).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts on a version above the schema pin and logs one drift line",
    async () => {
      const staged = await stage("probe-ready", "0.147.0");
      const result = await probe(staged);

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("0.147.0");
      expect(result.warnings[0]).toContain("0.146.0");
      expect(warnings).toEqual(result.warnings);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "warns exactly once about an unlisted model and does not block start",
    async () => {
      const staged = await stage("probe-model-missing");
      const result = await probe(staged);

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(MODEL);
      expect(result.warnings[0]).toContain("gpt-5.7-nova, gpt-5.6-luna");
      expect(warnings).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("ensureCodexAgentReady failure surfaces", () => {
  it(
    "retries a hung census once and then refuses with the timeout message",
    async () => {
      const staged = await stage("probe-hang");
      const result = await probe(staged, { timeoutMs: 400 });

      expect(refusalKind(result)).toBe("probe-timeout");
      if (result.status === "refused") {
        expect(result.error.message).toContain("readiness check timed out");
      }
      expect(await staged.spawnCount()).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports a child that dies mid-request as a crash, never as a timeout",
    async () => {
      const staged = await stage("probe-die-during-request");
      const result = await probe(staged, { timeoutMs: 5_000 });

      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.error.name).toBe("NetworkError");
      expect(result.error.message).not.toContain("readiness check timed out");
      expect(result.error.message).toMatch(/exit|signal|closed/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses when no binary resolves",
    async () => {
      const result = await ensureCodexAgentReady(
        { binaryPath: undefined, model: MODEL, baseEnv: { PATH: "", HOME: "/nonexistent-home" } },
        deps({
          resolveBinary: async () => null,
        }),
      );

      expect(refusalKind(result)).toBe("binary-missing");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("ensureCodexAgentReady cache", () => {
  it(
    "serves a second identical call from the capacity-1 cache",
    async () => {
      const staged = await stage("probe-ready");
      expect((await probe(staged)).status).toBe("ready");
      const afterFirst = await staged.spawnCount();

      expect((await probe(staged)).status).toBe("ready");
      expect(await staged.spawnCount()).toBe(afterFirst);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "re-censuses for a different model, an explicit refresh, an invalidation and an expired ttl",
    async () => {
      const staged = await stage("probe-ready");
      let clock = 1_000;
      const withClock = { now: () => clock };

      expect((await probe(staged, {}, withClock)).status).toBe("ready");
      expect(await staged.spawnCount()).toBe(2);

      expect((await probe(staged, { model: "gpt-5.6-luna" }, withClock)).status).toBe("ready");
      expect(await staged.spawnCount()).toBe(4);

      expect((await probe(staged, { model: "gpt-5.6-luna" }, withClock)).status).toBe("ready");
      expect(await staged.spawnCount()).toBe(4);

      expect(
        (await probe(staged, { model: "gpt-5.6-luna", forceRefresh: true }, withClock)).status,
      ).toBe("ready");
      expect(await staged.spawnCount()).toBe(6);

      invalidateCodexAgentProbeCache();
      expect((await probe(staged, { model: "gpt-5.6-luna" }, withClock)).status).toBe("ready");
      expect(await staged.spawnCount()).toBe(8);

      clock += CODEX_PROBE_CACHE_TTL_MS + 1;
      expect((await probe(staged, { model: "gpt-5.6-luna" }, withClock)).status).toBe("ready");
      expect(await staged.spawnCount()).toBe(10);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never caches a refusal",
    async () => {
      const staged = await stage("probe-account-apikey");
      expect((await probe(staged)).status).toBe("refused");
      const afterFirst = await staged.spawnCount();
      expect((await probe(staged)).status).toBe("refused");
      expect(await staged.spawnCount()).toBeGreaterThan(afterFirst);
    },
    TEST_TIMEOUT_MS,
  );
});
