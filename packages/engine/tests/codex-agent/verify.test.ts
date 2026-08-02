import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_MCP_BEARER_ENV_NAME,
  type CodexMcpEndpointOverride,
} from "../../src/agent/codex-agent/config-overrides.js";
import {
  startAppServer,
  type CodexAppServerSession,
} from "../../src/agent/codex-agent/session.js";
import {
  verifySpawnedChild,
  type CodexVerifyOutcome,
} from "../../src/agent/codex-agent/verify.js";
import { createFakeCodex, type FakeCodex } from "./helpers/fake-codex.js";

const SPAWN_TIMEOUT_MS = 20_000;

const MCP: CodexMcpEndpointOverride = {
  url: "http://127.0.0.1:54321/mcp",
  bearerEnvName: CODEX_MCP_BEARER_ENV_NAME,
  enabledTools: ["memory_read", "plan_save"],
};

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
}

describe("verifySpawnedChild (D-19)", () => {
  let fake: FakeCodex | null = null;
  const sessions: CodexAppServerSession[] = [];

  afterEach(async () => {
    while (sessions.length > 0) await sessions.pop()?.close();
    await fake?.cleanup();
    fake = null;
  });

  async function verifyChild(
    script: string,
    options: { census?: readonly string[]; mcp?: CodexMcpEndpointOverride } = {},
  ): Promise<{ outcome: CodexVerifyOutcome; session: CodexAppServerSession }> {
    const active = fake;
    if (active === null) throw new Error("the fake codex binary is not staged");
    await active.setScript(script);
    const session = await startAppServer({ binaryPath: active.binaryPath, baseEnv: baseEnv() });
    sessions.push(session);
    const outcome = await verifySpawnedChild(session.client, {
      censusForeignServers: options.census ?? ["alpha"],
      mcp: options.mcp ?? MCP,
    });
    return { outcome, session };
  }

  it(
    "accepts a generation child whose account, overrides and isolation all hold",
    async () => {
      fake = await createFakeCodex({ script: "gen-child-clean" });
      const { outcome, session } = await verifyChild("gen-child-clean");
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.account).toEqual({
        type: "chatgpt",
        email: "athlete@example.test",
        planType: "pro",
      });
      expect(outcome.foreignServers).toEqual(["alpha"]);

      const frames = await fake.readFramesIn();
      expect(frames.map((frame) => frame.method)).toEqual([
        "initialize",
        "initialized",
        "account/read",
        "config/read",
      ]);
      expect(frames[3]?.params).toEqual({ includeLayers: false });
      expect(session.client.terminated).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when the census said chatgpt but the generation child reports an api key (AC-18)",
    async () => {
      fake = await createFakeCodex({ script: "census-clean" });
      const census = await startAppServer({ binaryPath: fake.binaryPath, baseEnv: baseEnv() });
      sessions.push(census);
      const censusOutcome = await verifySpawnedChild(census.client, {
        censusForeignServers: ["alpha"],
      });
      expect(censusOutcome.status).toBe("ok");
      await census.close();

      const { outcome } = await verifyChild("gen-child-auth-flip");
      expect(outcome.status).toBe("refuse");
      if (outcome.status !== "refuse") return;
      expect(outcome.error.kind).toBe("account-not-chatgpt");
      expect(outcome.error.message).toContain("'apiKey'");
      expect(await fake.spawnCount()).toBe(2);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports a stale census when the child carries an enabled server the census never saw (AC-29)",
    async () => {
      fake = await createFakeCodex({ script: "gen-child-new-server" });
      const { outcome } = await verifyChild("gen-child-new-server");
      expect(outcome.status).toBe("stale-census");
      if (outcome.status !== "stale-census") return;
      expect(outcome.uncensusedServers).toEqual(["beta"]);
      expect(outcome.error.kind).toBe("mcp-isolation");
      expect(outcome.error.message).toContain("beta");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses instead of re-censusing when a censused server is still enabled",
    async () => {
      fake = await createFakeCodex({ script: "gen-child-new-server" });
      const { outcome } = await verifyChild("gen-child-new-server", {
        census: ["alpha", "beta"],
      });
      expect(outcome.status).toBe("refuse");
      if (outcome.status !== "refuse") return;
      expect(outcome.error.kind).toBe("mcp-isolation");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when chatgpt_base_url points at a foreign host (HR6)",
    async () => {
      fake = await createFakeCodex({ script: "config-read-foreign-chatgpt-base-url" });
      const { outcome } = await verifyChild("config-read-foreign-chatgpt-base-url");
      expect(outcome.status).toBe("refuse");
      if (outcome.status !== "refuse") return;
      expect(outcome.error.kind).toBe("endpoint-not-pinned");
      expect(outcome.error.message).toContain("chatgpt_base_url");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when a fixed override key is absent from config/read (AC-7)",
    async () => {
      fake = await createFakeCodex({ script: "config-read-override-missing-key" });
      const { outcome } = await verifyChild("config-read-override-missing-key");
      expect(outcome.status).toBe("refuse");
      if (outcome.status !== "refuse") return;
      expect(outcome.error.kind).toBe("override-mismatch");
      expect(outcome.error.message).toContain("features.hooks");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when a fixed override key comes back with a different value (AC-7)",
    async () => {
      fake = await createFakeCodex({ script: "config-read-override-mismatch" });
      const { outcome } = await verifyChild("config-read-override-mismatch");
      expect(outcome.status).toBe("refuse");
      if (outcome.status !== "refuse") return;
      expect(outcome.error.kind).toBe("override-mismatch");
      expect(outcome.error.message).toContain("sandbox_mode");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when the model provider is not the pinned built-in (HR6)",
    async () => {
      fake = await createFakeCodex({ script: "config-read-custom-provider" });
      const { outcome } = await verifyChild("config-read-custom-provider");
      expect(outcome.status).toBe("refuse");
      if (outcome.status !== "refuse") return;
      expect(outcome.error.kind).toBe("endpoint-not-pinned");
      expect(outcome.error.message).toContain("model_provider");
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("verifySpawnedChild against a stubbed request port", () => {
  const CLEAN_CONFIG = {
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    model_provider: "openai",
    openai_base_url: "",
    agents: { enabled: false },
    features: { shell_tool: false },
    mcp_servers: {},
  };

  function port(account: unknown, config: Record<string, unknown>) {
    const calls: Array<{ method: string; params: unknown }> = [];
    return {
      calls,
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "account/read") return { account } as unknown as T;
        if (method === "config/read") return { config } as unknown as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
  }

  const expected = [
    { key: "approval_policy", value: "never" },
    { key: "sandbox_mode", value: "read-only" },
    { key: "web_search", value: "disabled" },
    { key: "model_provider", value: "openai" },
    { key: "openai_base_url", value: "" },
    { key: "agents.enabled", value: false },
    { key: "features.shell_tool", value: false },
  ] as const;

  it("issues both reads concurrently before any verdict", async () => {
    const client = port({ type: "chatgpt", email: null, planType: "plus" }, CLEAN_CONFIG);
    const outcome = await verifySpawnedChild(client, { expectedOverrides: expected });
    expect(client.calls.map((call) => call.method)).toEqual(["account/read", "config/read"]);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.account.email).toBeNull();
    expect(outcome.account.planType).toBe("plus");
  });

  it("refuses a null account with the sign-in message", async () => {
    const client = port(null, CLEAN_CONFIG);
    const outcome = await verifySpawnedChild(client, { expectedOverrides: expected });
    expect(outcome.status).toBe("refuse");
    if (outcome.status !== "refuse") return;
    expect(outcome.error.kind).toBe("not-signed-in");
  });

  it("refuses an unmodelled account type fail-closed", async () => {
    const client = port({ type: "personalAccessToken" }, CLEAN_CONFIG);
    const outcome = await verifySpawnedChild(client, { expectedOverrides: expected });
    expect(outcome.status).toBe("refuse");
    if (outcome.status !== "refuse") return;
    expect(outcome.error.kind).toBe("account-not-chatgpt");
    expect(outcome.error.message).toContain("personalAccessToken");
  });

  it("accepts an absent chatgpt_base_url as the compiled-in default", async () => {
    const client = port({ type: "chatgpt", email: "a@b.test", planType: "pro" }, CLEAN_CONFIG);
    const outcome = await verifySpawnedChild(client, { expectedOverrides: expected });
    expect(outcome.status).toBe("ok");
  });

  it("treats a foreign server with no enabled flag as enabled", async () => {
    const client = port(
      { type: "chatgpt", email: "a@b.test", planType: "pro" },
      { ...CLEAN_CONFIG, mcp_servers: { gamma: { command: "gamma-server" } } },
    );
    const outcome = await verifySpawnedChild(client, {
      expectedOverrides: expected,
      censusForeignServers: ["gamma"],
    });
    expect(outcome.status).toBe("refuse");
  });

  it("refuses when our own tool endpoint was rewritten by the user config", async () => {
    const client = port(
      { type: "chatgpt", email: "a@b.test", planType: "pro" },
      {
        ...CLEAN_CONFIG,
        mcp_servers: {
          enduragent: {
            url: "http://127.0.0.1:1/mcp",
            bearer_token_env_var: CODEX_MCP_BEARER_ENV_NAME,
            enabled_tools: ["memory_read", "plan_save"],
            default_tools_approval_mode: "approve",
            enabled: true,
          },
        },
      },
    );
    const outcome = await verifySpawnedChild(client, {
      expectedOverrides: expected,
      mcp: MCP,
    });
    expect(outcome.status).toBe("refuse");
    if (outcome.status !== "refuse") return;
    expect(outcome.error.kind).toBe("mcp-isolation");
    expect(outcome.error.message).toContain("url");
  });

  it("refuses when our own tool endpoint lost its pre-approval mode", async () => {
    for (const approval of [undefined, "prompt", "auto", "writes"]) {
      const entry: Record<string, unknown> = {
        url: MCP.url,
        bearer_token_env_var: CODEX_MCP_BEARER_ENV_NAME,
        enabled_tools: ["memory_read", "plan_save"],
        enabled: true,
      };
      if (approval !== undefined) entry.default_tools_approval_mode = approval;
      const client = port(
        { type: "chatgpt", email: "a@b.test", planType: "pro" },
        { ...CLEAN_CONFIG, mcp_servers: { enduragent: entry } },
      );
      const outcome = await verifySpawnedChild(client, {
        expectedOverrides: expected,
        mcp: MCP,
      });
      expect(outcome.status, String(approval)).toBe("refuse");
      if (outcome.status !== "refuse") continue;
      expect(outcome.error.kind).toBe("mcp-isolation");
      expect(outcome.error.message).toContain("approval mode");
    }
  });

  it("accepts our own tool endpoint carrying the pre-approval mode", async () => {
    const client = port(
      { type: "chatgpt", email: "a@b.test", planType: "pro" },
      {
        ...CLEAN_CONFIG,
        mcp_servers: {
          enduragent: {
            url: MCP.url,
            bearer_token_env_var: CODEX_MCP_BEARER_ENV_NAME,
            enabled_tools: ["memory_read", "plan_save"],
            default_tools_approval_mode: "approve",
            enabled: true,
          },
        },
      },
    );
    const outcome = await verifySpawnedChild(client, {
      expectedOverrides: expected,
      mcp: MCP,
    });
    expect(outcome.status).toBe("ok");
  });

  it("refuses when our own tool endpoint is missing entirely", async () => {
    const client = port({ type: "chatgpt", email: "a@b.test", planType: "pro" }, CLEAN_CONFIG);
    const outcome = await verifySpawnedChild(client, {
      expectedOverrides: expected,
      mcp: MCP,
    });
    expect(outcome.status).toBe("refuse");
    if (outcome.status !== "refuse") return;
    expect(outcome.error.kind).toBe("mcp-isolation");
  });

  it("propagates a transport failure instead of returning a verdict", async () => {
    const client = {
      request: async <T>(method: string): Promise<T> => {
        if (method === "account/read") throw new Error("child died");
        return { config: CLEAN_CONFIG } as unknown as T;
      },
    };
    await expect(verifySpawnedChild(client, { expectedOverrides: expected })).rejects.toThrow(
      "child died",
    );
  });
});
