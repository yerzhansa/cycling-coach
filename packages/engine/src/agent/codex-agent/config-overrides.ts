import { mcpIsolationError } from "./errors.js";

export const CODEX_MCP_SERVER_NAME = "enduragent";
export const CODEX_MCP_BEARER_ENV_NAME = "ENDURAGENT_MCP_BEARER";
export const CODEX_MCP_TOOL_APPROVAL_MODE = "approve";
export const MAX_FOREIGN_MCP_SERVERS = 32;
export const FOREIGN_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export const CODEX_DISABLED_FEATURES: readonly string[] = [
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
];

export interface CodexBareValue {
  readonly bare: string;
}

export type CodexOverrideValue = string | number | boolean | readonly string[] | CodexBareValue;

export interface CodexConfigOverride {
  readonly key: string;
  readonly value: CodexOverrideValue;
}

export const CODEX_FIXED_CONFIG_OVERRIDES: readonly CodexConfigOverride[] = [
  { key: "approval_policy", value: "never" },
  { key: "sandbox_mode", value: "read-only" },
  { key: "web_search", value: "disabled" },
  { key: "model_provider", value: "openai" },
  { key: "openai_base_url", value: "" },
  { key: "agents.enabled", value: false },
  ...CODEX_DISABLED_FEATURES.map((feature) => ({
    key: `features.${feature}`,
    value: false as const,
  })),
];

function isBareValue(value: CodexOverrideValue): value is CodexBareValue {
  return typeof value === "object" && !Array.isArray(value);
}

export function encodeTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

export function encodeTomlValue(value: CodexOverrideValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return encodeTomlString(value);
  if (isBareValue(value)) return value.bare;
  return `[${value.map(encodeTomlString).join(",")}]`;
}

export function overrideArg(key: string, value: CodexOverrideValue): string {
  return `${key}=${encodeTomlValue(value)}`;
}

export function assertForeignServerNamesSafe(names: readonly string[]): void {
  for (const name of names) {
    if (name === CODEX_MCP_SERVER_NAME) {
      throw mcpIsolationError(
        `a user-defined MCP server is already named '${CODEX_MCP_SERVER_NAME}'`,
      );
    }
  }
  for (const name of names) {
    if (!FOREIGN_SERVER_NAME_PATTERN.test(name)) {
      throw mcpIsolationError(
        `the MCP server name '${name}' cannot be safely disabled through a config override`,
      );
    }
  }
  if (names.length > MAX_FOREIGN_MCP_SERVERS) {
    throw mcpIsolationError(
      `${names.length} MCP servers are configured, above the supported maximum of ${MAX_FOREIGN_MCP_SERVERS}`,
    );
  }
}

export interface CodexMcpEndpointOverride {
  readonly url: string;
  readonly bearerEnvName: string;
  readonly enabledTools: readonly string[];
}

export interface BuildConfigOverrideArgsOptions {
  readonly foreignServers?: readonly string[];
  readonly mcp?: CodexMcpEndpointOverride;
}

export function buildConfigOverrideArgs(
  options: BuildConfigOverrideArgsOptions = {},
): string[] {
  const foreignServers = options.foreignServers ?? [];
  assertForeignServerNamesSafe(foreignServers);

  const args: string[] = [];
  for (const override of CODEX_FIXED_CONFIG_OVERRIDES) {
    args.push("-c", overrideArg(override.key, override.value));
  }

  const seen = new Set<string>();
  for (const name of foreignServers) {
    if (seen.has(name)) continue;
    seen.add(name);
    args.push("-c", overrideArg(`mcp_servers.${name}.enabled`, false));
  }

  const mcp = options.mcp;
  if (mcp !== undefined) {
    const prefix = `mcp_servers.${CODEX_MCP_SERVER_NAME}`;
    args.push("-c", overrideArg(`${prefix}.url`, { bare: mcp.url }));
    args.push("-c", overrideArg(`${prefix}.bearer_token_env_var`, mcp.bearerEnvName));
    args.push("-c", overrideArg(`${prefix}.enabled_tools`, mcp.enabledTools));
    args.push(
      "-c",
      overrideArg(`${prefix}.default_tools_approval_mode`, CODEX_MCP_TOOL_APPROVAL_MODE),
    );
  }

  return args;
}
