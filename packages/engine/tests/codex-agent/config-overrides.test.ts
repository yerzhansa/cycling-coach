import { describe, expect, it } from "vitest";

import {
  CODEX_DISABLED_FEATURES,
  CODEX_FIXED_CONFIG_OVERRIDES,
  CODEX_MCP_BEARER_ENV_NAME,
  CODEX_MCP_SERVER_NAME,
  CODEX_MCP_TOOL_APPROVAL_MODE,
  MAX_FOREIGN_MCP_SERVERS,
  assertForeignServerNamesSafe,
  buildConfigOverrideArgs,
  encodeTomlValue,
} from "../../src/agent/codex-agent/config-overrides.js";
import { CodexAgentConfigError } from "../../src/agent/codex-agent/errors.js";

const ENDPOINT = {
  url: "http://127.0.0.1:53421/mcp",
  bearerEnvName: CODEX_MCP_BEARER_ENV_NAME,
  enabledTools: ["memory_read", "intervals_fetch_athlete"] as const,
};

function overrideValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-c") {
      const value = args[i + 1];
      if (value !== undefined) out.push(value);
    }
  }
  return out;
}

describe("TOML value encoding", () => {
  it("emits booleans and numbers bare and strings quoted", () => {
    expect(encodeTomlValue(false)).toBe("false");
    expect(encodeTomlValue(true)).toBe("true");
    expect(encodeTomlValue(32)).toBe("32");
    expect(encodeTomlValue("disabled")).toBe('"disabled"');
    expect(encodeTomlValue("")).toBe('""');
  });

  it("escapes quotes and backslashes inside a string value", () => {
    expect(encodeTomlValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("emits an inline array of quoted strings", () => {
    expect(encodeTomlValue(["a", "b"])).toBe('["a","b"]');
  });

  it("emits a bare value verbatim so a URL is not double-quoted", () => {
    expect(encodeTomlValue({ bare: "http://127.0.0.1:1/mcp" })).toBe("http://127.0.0.1:1/mcp");
  });
});

describe("the fixed override set", () => {
  it("pins every key in the coaching-safe set with its exact value", () => {
    const values = overrideValues(buildConfigOverrideArgs());
    for (const expected of [
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      'web_search="disabled"',
      'model_provider="openai"',
      'openai_base_url=""',
      "agents.enabled=false",
    ]) {
      expect(values, expected).toContain(expected);
    }
  });

  it("closes all three multi-agent legs and every exec, browser, plugin and hook feature", () => {
    const values = overrideValues(buildConfigOverrideArgs());
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "apps",
      "hooks",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "image_generation",
      "skill_search",
      "goals",
      "guardian_approval",
      "tool_call_mcp_elicitation",
      "in_app_browser",
      "tool_suggest",
      "shell_snapshot",
      "code_mode_host",
    ]) {
      expect(values, feature).toContain(`features.${feature}=false`);
    }
    expect(CODEX_DISABLED_FEATURES).toHaveLength(20);
    expect(new Set(CODEX_DISABLED_FEATURES).size).toBe(CODEX_DISABLED_FEATURES.length);
  });

  it("emits one -c flag per leaf and nothing else when no servers are involved", () => {
    const args = buildConfigOverrideArgs();
    expect(args).toHaveLength(CODEX_FIXED_CONFIG_OVERRIDES.length * 2);
    for (let i = 0; i < args.length; i += 2) expect(args[i]).toBe("-c");
    expect(overrideValues(args)).toHaveLength(CODEX_FIXED_CONFIG_OVERRIDES.length);
  });

  it("spells the sandbox in config.toml casing, never the wire casing", () => {
    const values = overrideValues(buildConfigOverrideArgs());
    expect(values).toContain('sandbox_mode="read-only"');
    expect(values.join(" ")).not.toContain("readOnly");
  });

  it("is deterministic across calls", () => {
    expect(buildConfigOverrideArgs({ foreignServers: ["alpha", "beta"], mcp: ENDPOINT })).toEqual(
      buildConfigOverrideArgs({ foreignServers: ["alpha", "beta"], mcp: ENDPOINT }),
    );
  });
});

describe("foreign server isolation", () => {
  it("disables every enumerated foreign server alongside our own three leaves", () => {
    const values = overrideValues(
      buildConfigOverrideArgs({ foreignServers: ["alpha", "beta", "gamma"], mcp: ENDPOINT }),
    );
    expect(values).toContain("mcp_servers.alpha.enabled=false");
    expect(values).toContain("mcp_servers.beta.enabled=false");
    expect(values).toContain("mcp_servers.gamma.enabled=false");
    expect(values).toContain(`mcp_servers.${CODEX_MCP_SERVER_NAME}.url=${ENDPOINT.url}`);
    expect(values).toContain(
      `mcp_servers.${CODEX_MCP_SERVER_NAME}.bearer_token_env_var="${CODEX_MCP_BEARER_ENV_NAME}"`,
    );
    expect(values).toContain(
      `mcp_servers.${CODEX_MCP_SERVER_NAME}.enabled_tools=["memory_read","intervals_fetch_athlete"]`,
    );
    expect(values).toContain(
      `mcp_servers.${CODEX_MCP_SERVER_NAME}.default_tools_approval_mode="${CODEX_MCP_TOOL_APPROVAL_MODE}"`,
    );
  });

  it("pre-approves only our own server's tools and never a foreign server's", () => {
    const values = overrideValues(
      buildConfigOverrideArgs({ foreignServers: ["alpha", "beta"], mcp: ENDPOINT }),
    );
    const approvals = values.filter((value) => value.includes("default_tools_approval_mode"));
    expect(approvals).toEqual([
      `mcp_servers.${CODEX_MCP_SERVER_NAME}.default_tools_approval_mode="${CODEX_MCP_TOOL_APPROVAL_MODE}"`,
    ]);
  });

  it("emits no approval-mode override when no endpoint is attached", () => {
    const values = overrideValues(buildConfigOverrideArgs({ foreignServers: ["alpha"] }));
    expect(values.some((value) => value.includes("default_tools_approval_mode"))).toBe(false);
  });

  it("never puts the bearer token itself into argv", () => {
    const args = buildConfigOverrideArgs({ foreignServers: ["alpha"], mcp: ENDPOINT });
    expect(args.join(" ")).not.toContain("secret");
    expect(args.join(" ")).toContain(CODEX_MCP_BEARER_ENV_NAME);
  });

  it("declares no mcp server at all for a stateless caller", () => {
    const values = overrideValues(buildConfigOverrideArgs({ foreignServers: ["alpha"] }));
    expect(values).toContain("mcp_servers.alpha.enabled=false");
    expect(values.some((value) => value.includes(CODEX_MCP_SERVER_NAME))).toBe(false);
  });

  it("deduplicates a repeated server name", () => {
    const values = overrideValues(buildConfigOverrideArgs({ foreignServers: ["alpha", "alpha"] }));
    expect(values.filter((value) => value === "mcp_servers.alpha.enabled=false")).toHaveLength(1);
  });

  it("accepts exactly the supported maximum number of servers", () => {
    const names = Array.from({ length: MAX_FOREIGN_MCP_SERVERS }, (_, i) => `srv-${i}`);
    expect(() => buildConfigOverrideArgs({ foreignServers: names })).not.toThrow();
  });
});

describe("fail-closed isolation refusals", () => {
  function expectIsolationRefusal(names: readonly string[], detail: string): void {
    try {
      buildConfigOverrideArgs({ foreignServers: names });
      expect.unreachable("expected an isolation refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAgentConfigError);
      expect((err as CodexAgentConfigError).kind).toBe("mcp-isolation");
      const message = (err as Error).message;
      expect(message).toContain("Cannot safely isolate the Codex MCP configuration");
      expect(message).toContain(detail);
      expect(message).toContain("~/.codex/config.toml");
    }
  }

  it("refuses a server name whose -c key path would nest instead of disable", () => {
    expectIsolationRefusal(["my.server"], "'my.server'");
  });

  it("refuses a server name carrying a space", () => {
    expectIsolationRefusal(["my server"], "'my server'");
  });

  it("refuses a server name carrying an equals sign", () => {
    expectIsolationRefusal(["a=b"], "'a=b'");
  });

  it("refuses a server name carrying a double quote", () => {
    expectIsolationRefusal(['srv"x'], 'srv"x');
  });

  it("refuses a user-defined server colliding with our own name", () => {
    expectIsolationRefusal(["alpha", CODEX_MCP_SERVER_NAME], `named '${CODEX_MCP_SERVER_NAME}'`);
  });

  it("refuses more servers than the argv cap allows", () => {
    const names = Array.from({ length: MAX_FOREIGN_MCP_SERVERS + 1 }, (_, i) => `srv-${i}`);
    expectIsolationRefusal(names, `${MAX_FOREIGN_MCP_SERVERS + 1} MCP servers are configured`);
  });

  it("exposes the same guard for the census to reuse before any argv is built", () => {
    expect(() => assertForeignServerNamesSafe(["alpha", "beta"])).not.toThrow();
    expect(() => assertForeignServerNamesSafe(["alpha.beta"])).toThrow(CodexAgentConfigError);
  });
});
