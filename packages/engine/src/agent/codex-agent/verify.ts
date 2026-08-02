import {
  CODEX_FIXED_CONFIG_OVERRIDES,
  CODEX_MCP_SERVER_NAME,
  CODEX_MCP_TOOL_APPROVAL_MODE,
  type CodexConfigOverride,
  type CodexMcpEndpointOverride,
} from "./config-overrides.js";
import {
  accountNotChatgptError,
  endpointNotPinnedError,
  mcpIsolationError,
  notSignedInError,
  overrideMismatchError,
  type CodexAgentConfigError,
} from "./errors.js";

export const CODEX_CHATGPT_HOST = "chatgpt.com";
export const CODEX_ENDPOINT_PINNED_KEYS: readonly string[] = ["model_provider", "openai_base_url"];

export interface CodexRequestPort {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface CodexChatgptAccount {
  readonly type: "chatgpt";
  readonly email: string | null;
  readonly planType: string;
}

export interface CodexAccountResponse {
  readonly account?: { readonly type?: unknown; readonly [key: string]: unknown } | null;
  readonly requiresOpenaiAuth?: boolean;
}

export interface CodexConfigResponse {
  readonly config?: Record<string, unknown>;
}

export type CodexVerifyOutcome =
  | {
      readonly status: "ok";
      readonly account: CodexChatgptAccount;
      readonly foreignServers: readonly string[];
    }
  | {
      readonly status: "stale-census";
      readonly error: CodexAgentConfigError;
      readonly uncensusedServers: readonly string[];
      readonly foreignServers: readonly string[];
    }
  | { readonly status: "refuse"; readonly error: CodexAgentConfigError };

export interface VerifySpawnedChildOptions {
  readonly expectedOverrides?: readonly CodexConfigOverride[];
  readonly censusForeignServers?: readonly string[];
  readonly mcp?: CodexMcpEndpointOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ConfigLookup {
  readonly found: boolean;
  readonly value: unknown;
}

export function readConfigPath(config: Record<string, unknown>, path: string): ConfigLookup {
  let cursor: unknown = config;
  for (const segment of path.split(".")) {
    if (!isRecord(cursor) || !(segment in cursor)) return { found: false, value: undefined };
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

function overrideMatches(expected: CodexConfigOverride["value"], actual: unknown): boolean {
  if (typeof expected === "boolean" || typeof expected === "number") return actual === expected;
  if (typeof expected === "string") return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const left = [...expected].sort();
    const right = [...(actual as unknown[])].map((entry) => String(entry)).sort();
    return left.every((entry, index) => entry === right[index]);
  }
  return false;
}

function chatgptAccountFrom(response: CodexAccountResponse): CodexChatgptAccount | null {
  const account = response.account;
  if (account === null || account === undefined) return null;
  if (account.type !== "chatgpt") return null;
  const email = typeof account.email === "string" ? account.email : null;
  const planType = typeof account.planType === "string" ? account.planType : "unknown";
  return { type: "chatgpt", email, planType };
}

function accountTypeLabel(response: CodexAccountResponse): string {
  const account = response.account;
  if (!isRecord(account)) return "unknown";
  return typeof account.type === "string" ? account.type : "unknown";
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function refuse(error: CodexAgentConfigError): CodexVerifyOutcome {
  return { status: "refuse", error };
}

export function verifyConfigOverrides(
  config: Record<string, unknown>,
  expected: readonly CodexConfigOverride[] = CODEX_FIXED_CONFIG_OVERRIDES,
): CodexAgentConfigError | null {
  for (const override of expected) {
    const lookup = readConfigPath(config, override.key);
    if (!lookup.found) return overrideMismatchError(override.key);
    if (overrideMatches(override.value, lookup.value)) continue;
    if (CODEX_ENDPOINT_PINNED_KEYS.includes(override.key)) {
      return endpointNotPinnedError(override.key);
    }
    return overrideMismatchError(override.key);
  }

  const chatgptBaseUrl = readConfigPath(config, "chatgpt_base_url");
  if (
    chatgptBaseUrl.found &&
    chatgptBaseUrl.value !== null &&
    chatgptBaseUrl.value !== undefined &&
    chatgptBaseUrl.value !== ""
  ) {
    if (typeof chatgptBaseUrl.value !== "string") {
      return endpointNotPinnedError("chatgpt_base_url");
    }
    if (hostOf(chatgptBaseUrl.value) !== CODEX_CHATGPT_HOST) {
      return endpointNotPinnedError("chatgpt_base_url");
    }
  }

  return null;
}

function serverIsEnabled(entry: unknown): boolean {
  if (!isRecord(entry)) return true;
  return entry.enabled !== false;
}

function verifyOwnMcpServer(
  servers: Record<string, unknown>,
  mcp: CodexMcpEndpointOverride,
): CodexAgentConfigError | null {
  const entry = servers[CODEX_MCP_SERVER_NAME];
  if (!isRecord(entry)) {
    return mcpIsolationError(`the '${CODEX_MCP_SERVER_NAME}' tool endpoint is missing`);
  }
  if (!serverIsEnabled(entry)) {
    return mcpIsolationError(`the '${CODEX_MCP_SERVER_NAME}' tool endpoint is disabled`);
  }
  if (entry.url !== mcp.url) {
    return mcpIsolationError(`the '${CODEX_MCP_SERVER_NAME}' tool endpoint url was rewritten`);
  }
  if (entry.bearer_token_env_var !== mcp.bearerEnvName) {
    return mcpIsolationError(
      `the '${CODEX_MCP_SERVER_NAME}' tool endpoint credential binding was rewritten`,
    );
  }
  if (!overrideMatches(mcp.enabledTools, entry.enabled_tools)) {
    return mcpIsolationError(`the '${CODEX_MCP_SERVER_NAME}' tool allowlist was rewritten`);
  }
  if (entry.default_tools_approval_mode !== CODEX_MCP_TOOL_APPROVAL_MODE) {
    return mcpIsolationError(
      `the '${CODEX_MCP_SERVER_NAME}' tool approval mode was rewritten`,
    );
  }
  return null;
}

export async function verifySpawnedChild(
  client: CodexRequestPort,
  options: VerifySpawnedChildOptions = {},
): Promise<CodexVerifyOutcome> {
  const settled = await Promise.allSettled([
    client.request<CodexAccountResponse>("account/read", {}),
    client.request<CodexConfigResponse>("config/read", { includeLayers: false }),
  ]);
  for (const outcome of settled) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
  const [accountSettled, configSettled] = settled;
  const accountResponse =
    accountSettled?.status === "fulfilled" ? accountSettled.value : ({} as CodexAccountResponse);
  const configResponse =
    configSettled?.status === "fulfilled" ? configSettled.value : ({} as CodexConfigResponse);

  const account = chatgptAccountFrom(accountResponse);
  if (account === null) {
    if (accountResponse.account === null || accountResponse.account === undefined) {
      return refuse(notSignedInError());
    }
    return refuse(accountNotChatgptError(accountTypeLabel(accountResponse)));
  }

  const config = isRecord(configResponse.config) ? configResponse.config : {};
  const overrideFailure = verifyConfigOverrides(
    config,
    options.expectedOverrides ?? CODEX_FIXED_CONFIG_OVERRIDES,
  );
  if (overrideFailure !== null) return refuse(overrideFailure);

  const serversValue = readConfigPath(config, "mcp_servers").value;
  const servers = isRecord(serversValue) ? serversValue : {};

  if (options.mcp !== undefined) {
    const ownFailure = verifyOwnMcpServer(servers, options.mcp);
    if (ownFailure !== null) return refuse(ownFailure);
  }

  const foreignServers = Object.keys(servers).filter(
    (name) => options.mcp === undefined || name !== CODEX_MCP_SERVER_NAME,
  );
  const enabledForeign = foreignServers.filter((name) => serverIsEnabled(servers[name]));

  if (enabledForeign.length > 0) {
    const census = options.censusForeignServers ?? [];
    const uncensused = enabledForeign.filter((name) => !census.includes(name));
    const detail = `the MCP server '${enabledForeign.join("', '")}' is still enabled for this turn`;
    const error = mcpIsolationError(detail);
    if (uncensused.length === enabledForeign.length) {
      return { status: "stale-census", error, uncensusedServers: uncensused, foreignServers };
    }
    return refuse(error);
  }

  return { status: "ok", account, foreignServers };
}
