import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

export type ClaudeCliBilling = "subscription" | "api-key";

export interface ClaudeCliRuntime {
  binaryPath: string;
  configDir?: string;
  billing: ClaudeCliBilling;
}

export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
];

export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
];

const CREDENTIAL_PREFIX_PATTERN = /^(ANTHROPIC_|CLAUDE_CODE_)/;

export class ForbiddenChildEnvKeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Refusing to spawn the Claude Code CLI: forbidden credential variable '${key}' reached the child environment.`,
    );
    this.name = "ForbiddenChildEnvKeyError";
    this.key = key;
  }
}

function strictAssertions(): boolean {
  const mode = process.env.NODE_ENV;
  return mode === "test" || mode === "development";
}

export function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolvePath(homedir(), value.slice(2));
  return value;
}

function resolveConfigDir(value: string): string {
  const expanded = expandTilde(value);
  return isAbsolute(expanded) ? expanded : resolvePath(expanded);
}

export function assertNoForbiddenChildEnv(
  env: NodeJS.ProcessEnv,
  introduced: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set(introduced);
  const strict = strictAssertions();
  for (const key of Object.keys(env)) {
    if (allowed.has(key)) continue;
    if (!FORBIDDEN_ENV_KEYS.includes(key) && !CREDENTIAL_PREFIX_PATTERN.test(key)) continue;
    if (strict) throw new ForbiddenChildEnvKeyError(key);
    delete env[key];
  }
  return env;
}

export function buildChildEnv(base: NodeJS.ProcessEnv, rt: ClaudeCliRuntime): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) out[key] = value;
  }

  if (rt.configDir !== undefined && rt.configDir !== "") {
    out.CLAUDE_CONFIG_DIR = resolveConfigDir(rt.configDir);
  } else if (base.CLAUDE_CONFIG_DIR !== undefined) {
    out.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  }

  const introduced: string[] = [];
  if (rt.billing === "api-key") {
    const apiKey = base.ANTHROPIC_API_KEY;
    if (apiKey !== undefined) {
      out.ANTHROPIC_API_KEY = apiKey;
      introduced.push("ANTHROPIC_API_KEY");
    }
  }

  return assertNoForbiddenChildEnv(out, introduced);
}
