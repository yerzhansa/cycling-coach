import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath, win32 } from "node:path";

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

export const WINDOWS_CHILD_ENV_ALLOWLIST: readonly string[] = [
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
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

export interface ClaudeCliPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export function readEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const exact = env[key];
  if (exact !== undefined || platform !== "win32") return exact;
  const normalized = key.toUpperCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toUpperCase() === normalized && value !== undefined) return value;
  }
  return undefined;
}

function resolvedHome(options: ClaudeCliPathOptions): string {
  const platform = options.platform ?? process.platform;
  if (options.home !== undefined) return options.home;
  if (platform === "win32" && options.env !== undefined) {
    const profile = readEnvironmentValue(options.env, "USERPROFILE", platform);
    if (profile !== undefined && profile !== "") return profile;
  }
  return homedir();
}

export function expandTilde(value: string, options: ClaudeCliPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = resolvedHome(options);
  if (value === "~") return home;
  if (platform === "win32" && (value.startsWith("~/") || value.startsWith("~\\"))) {
    return win32.resolve(home, value.slice(2));
  }
  if (value.startsWith("~/")) return resolvePath(home, value.slice(2));
  return value;
}

function resolveConfigDir(value: string, options: ClaudeCliPathOptions): string {
  const platform = options.platform ?? process.platform;
  const expanded = expandTilde(value, options);
  if (platform === "win32") {
    return win32.isAbsolute(expanded) ? expanded : win32.resolve(expanded);
  }
  return isAbsolute(expanded) ? expanded : resolvePath(expanded);
}

export function assertNoForbiddenChildEnv(
  env: NodeJS.ProcessEnv,
  introduced: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = new Set(
    platform === "win32" ? introduced.map((key) => key.toUpperCase()) : introduced,
  );
  const strict = strictAssertions();
  for (const key of Object.keys(env)) {
    const compared = platform === "win32" ? key.toUpperCase() : key;
    if (allowed.has(compared)) continue;
    if (!FORBIDDEN_ENV_KEYS.includes(compared) && !CREDENTIAL_PREFIX_PATTERN.test(compared)) {
      continue;
    }
    if (strict) throw new ForbiddenChildEnvKeyError(key);
    delete env[key];
  }
  return env;
}

export type BuildClaudeCliChildEnvOptions = ClaudeCliPathOptions;

function windowsRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...env };
  for (const key of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"]) {
    const value = readEnvironmentValue(env, key, "win32");
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

export function buildChildEnv(
  inputEnv: NodeJS.ProcessEnv,
  rt: ClaudeCliRuntime,
  options: BuildClaudeCliChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const base = platform === "win32" ? windowsRuntimeEnvironment(inputEnv) : inputEnv;
  const out: NodeJS.ProcessEnv = {};

  if (platform === "win32") {
    const seen = new Set<string>();
    for (const key of [...CHILD_ENV_ALLOWLIST, ...WINDOWS_CHILD_ENV_ALLOWLIST]) {
      const canonical = key.toUpperCase();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const value = readEnvironmentValue(base, key, platform);
      if (value !== undefined) out[canonical] = value;
    }
  } else {
    for (const key of CHILD_ENV_ALLOWLIST) {
      const value = base[key];
      if (value !== undefined) out[key] = value;
    }
  }

  if (rt.configDir !== undefined && rt.configDir !== "") {
    out.CLAUDE_CONFIG_DIR = resolveConfigDir(rt.configDir, {
      ...options,
      platform,
      env: options.env ?? base,
    });
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
