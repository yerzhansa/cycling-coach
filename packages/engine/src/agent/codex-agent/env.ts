export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "LANG",
  "TERM",
  "COLORTERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

export const CHILD_ENV_ALLOWLIST_PREFIXES: readonly RegExp[] = [/^LC_[A-Z]+$/, /^XDG_[A-Z_]+$/];

export const FORBIDDEN_ENV_KEYS: readonly string[] = [
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
];

export const CREDENTIAL_PREFIX_PATTERN = /^(CODEX_|OPENAI_)/;

export class ForbiddenChildEnvKeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Refusing to spawn the Codex CLI: forbidden credential variable '${key}' reached the child environment.`,
    );
    this.name = "ForbiddenChildEnvKeyError";
    this.key = key;
  }
}

export class InvalidBearerEnvNameError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Refusing to spawn the Codex CLI: '${key}' is not a usable name for the MCP bearer variable.`,
    );
    this.name = "InvalidBearerEnvNameError";
    this.key = key;
  }
}

const BEARER_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function strictAssertions(): boolean {
  const mode = process.env.NODE_ENV;
  return mode === "test" || mode === "development";
}

function isAllowlisted(key: string): boolean {
  if (CHILD_ENV_ALLOWLIST.includes(key)) return true;
  return CHILD_ENV_ALLOWLIST_PREFIXES.some((pattern) => pattern.test(key));
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

export interface CodexChildEnvOptions {
  readonly bearerEnvName?: string;
  readonly bearerToken?: string;
}

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  options: CodexChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};

  for (const key of Object.keys(base)) {
    if (!isAllowlisted(key)) continue;
    const value = base[key];
    if (value !== undefined) out[key] = value;
  }

  const introduced: string[] = [];
  const { bearerEnvName, bearerToken } = options;
  if (bearerEnvName !== undefined || bearerToken !== undefined) {
    if (
      bearerEnvName === undefined ||
      bearerEnvName === "" ||
      bearerToken === undefined ||
      bearerToken === ""
    ) {
      throw new InvalidBearerEnvNameError(bearerEnvName ?? "");
    }
    if (
      !BEARER_ENV_NAME_PATTERN.test(bearerEnvName) ||
      FORBIDDEN_ENV_KEYS.includes(bearerEnvName) ||
      CREDENTIAL_PREFIX_PATTERN.test(bearerEnvName)
    ) {
      throw new InvalidBearerEnvNameError(bearerEnvName);
    }
    out[bearerEnvName] = bearerToken;
    introduced.push(bearerEnvName);
  }

  return assertNoForbiddenChildEnv(out, introduced);
}
