import { afterEach, describe, expect, it } from "vitest";

import {
  CHILD_ENV_ALLOWLIST,
  CHILD_ENV_ALLOWLIST_PREFIXES,
  CREDENTIAL_PREFIX_PATTERN,
  FORBIDDEN_ENV_KEYS,
  ForbiddenChildEnvKeyError,
  InvalidBearerEnvNameError,
  assertNoForbiddenChildEnv,
  buildChildEnv,
} from "../../src/agent/codex-agent/env.js";
import { CODEX_MCP_BEARER_ENV_NAME } from "../../src/agent/codex-agent/config-overrides.js";

const SENTINEL = "codex-sentinel-do-not-leak-0000";
const BEARER = "bearer-sentinel-do-not-leak-1111";

function pollutedBase(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    USER: "tester",
    LOGNAME: "tester",
    TMPDIR: "/var/folders/tmp/",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    CODEX_API_KEY: SENTINEL,
    CODEX_ACCESS_TOKEN: SENTINEL,
    CODEX_HOME: "/Users/tester/.codex",
    OPENAI_API_KEY: SENTINEL,
    OPENAI_BASE_URL: "https://proxy.example/v1",
    CODEX_SOMETHING_NEW: SENTINEL,
    OPENAI_FUTURE_FLAG: "1",
    ANTHROPIC_API_KEY: SENTINEL,
    AWS_SECRET_ACCESS_KEY: SENTINEL,
    RANDOM_UNRELATED: "keep-me-out",
    ...extra,
  };
}

const savedNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe("buildChildEnv allowlist", () => {
  it("builds from an empty object rather than filtering a passthrough", () => {
    const env = buildChildEnv(pollutedBase());
    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
    ]);
  });

  it("keeps the allowlisted values verbatim", () => {
    const env = buildChildEnv(pollutedBase());
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.USER).toBe("tester");
    expect(env.LOGNAME).toBe("tester");
    expect(env.TMPDIR).toBe("/var/folders/tmp/");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
  });

  it("drops unrelated parent variables the child has no business reading", () => {
    const env = buildChildEnv(pollutedBase());
    expect(env.RANDOM_UNRELATED).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("carries proxy plumbing, the extra CA bundle and the temp aliases", () => {
    const env = buildChildEnv(
      pollutedBase({
        TEMP: "/tmp",
        TMP: "/tmp",
        COLORTERM: "truecolor",
        HTTP_PROXY: "http://proxy:3128",
        HTTPS_PROXY: "http://proxy:3129",
        NO_PROXY: "localhost",
        http_proxy: "http://proxy:3128",
        https_proxy: "http://proxy:3129",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      }),
    );
    expect(env.TEMP).toBe("/tmp");
    expect(env.TMP).toBe("/tmp");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.HTTP_PROXY).toBe("http://proxy:3128");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3129");
    expect(env.NO_PROXY).toBe("localhost");
    expect(env.http_proxy).toBe("http://proxy:3128");
    expect(env.https_proxy).toBe("http://proxy:3129");
    expect(env.no_proxy).toBe("localhost");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
  });

  it("carries every LC_ locale variable and every XDG directory", () => {
    const env = buildChildEnv(
      pollutedBase({
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
        LC_MESSAGES: "en_US.UTF-8",
        XDG_CONFIG_HOME: "/home/tester/.config",
        XDG_DATA_HOME: "/home/tester/.local/share",
        XDG_CACHE_HOME: "/home/tester/.cache",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
    );
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(env.LC_MESSAGES).toBe("en_US.UTF-8");
    expect(env.XDG_CONFIG_HOME).toBe("/home/tester/.config");
    expect(env.XDG_DATA_HOME).toBe("/home/tester/.local/share");
    expect(env.XDG_CACHE_HOME).toBe("/home/tester/.cache");
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
  });

  it("omits allowlisted keys that are absent from the parent instead of defining them empty", () => {
    const env = buildChildEnv({ PATH: "/usr/bin", HOME: "/Users/tester" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  it("keeps every allowlist entry unique and free of credential prefixes", () => {
    expect(new Set(CHILD_ENV_ALLOWLIST).size).toBe(CHILD_ENV_ALLOWLIST.length);
    for (const key of CHILD_ENV_ALLOWLIST) {
      expect(CREDENTIAL_PREFIX_PATTERN.test(key), key).toBe(false);
    }
    for (const pattern of CHILD_ENV_ALLOWLIST_PREFIXES) {
      expect(pattern.test("CODEX_HOME")).toBe(false);
      expect(pattern.test("OPENAI_API_KEY")).toBe(false);
    }
  });
});

describe("buildChildEnv forbidden keys", () => {
  it("names exactly the five forbidden variables", () => {
    expect([...FORBIDDEN_ENV_KEYS]).toEqual([
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CODEX_HOME",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]);
  });

  it("keeps every forbidden variable out of the child even when the parent has all of them", () => {
    const env = buildChildEnv(pollutedBase());
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("keeps unknown CODEX_ and OPENAI_ prefixed variables out of the child", () => {
    const env = buildChildEnv(pollutedBase());
    expect(env.CODEX_SOMETHING_NEW).toBeUndefined();
    expect(env.OPENAI_FUTURE_FLAG).toBeUndefined();
  });

  it("leaks no sentinel-valued secret into the child environment", () => {
    const env = buildChildEnv(pollutedBase());
    expect(JSON.stringify(env)).not.toContain(SENTINEL);
  });
});

describe("buildChildEnv bearer introduction", () => {
  it("introduces exactly one key beyond the allowlist", () => {
    const withoutBearer = Object.keys(buildChildEnv(pollutedBase())).sort();
    const withBearer = buildChildEnv(pollutedBase(), {
      bearerEnvName: CODEX_MCP_BEARER_ENV_NAME,
      bearerToken: BEARER,
    });
    expect(withBearer[CODEX_MCP_BEARER_ENV_NAME]).toBe(BEARER);
    expect(Object.keys(withBearer).sort()).toEqual(
      [...withoutBearer, CODEX_MCP_BEARER_ENV_NAME].sort(),
    );
  });

  it("introduces nothing on a census or version spawn", () => {
    const env = buildChildEnv(pollutedBase());
    expect(env[CODEX_MCP_BEARER_ENV_NAME]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(BEARER);
  });

  it("refuses a bearer variable name that would smuggle a forbidden key past the assertion", () => {
    for (const name of ["CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY", "OPENAI_ANYTHING"]) {
      expect(() =>
        buildChildEnv(pollutedBase(), { bearerEnvName: name, bearerToken: BEARER }),
      ).toThrow(InvalidBearerEnvNameError);
    }
  });

  it("refuses a malformed bearer variable name", () => {
    for (const name of ["lower_case", "HAS SPACE", "1LEADING", ""]) {
      expect(() =>
        buildChildEnv(pollutedBase(), { bearerEnvName: name, bearerToken: BEARER }),
      ).toThrow(InvalidBearerEnvNameError);
    }
  });

  it("refuses a half-specified bearer pair rather than spawning without the token", () => {
    expect(() =>
      buildChildEnv(pollutedBase(), { bearerEnvName: CODEX_MCP_BEARER_ENV_NAME }),
    ).toThrow(InvalidBearerEnvNameError);
    expect(() => buildChildEnv(pollutedBase(), { bearerToken: BEARER })).toThrow(
      InvalidBearerEnvNameError,
    );
  });
});

describe("assertNoForbiddenChildEnv", () => {
  it("throws under test/dev when a forbidden key reaches the child env", () => {
    process.env.NODE_ENV = "test";
    expect(() => assertNoForbiddenChildEnv({ CODEX_ACCESS_TOKEN: SENTINEL })).toThrow(
      ForbiddenChildEnvKeyError,
    );
  });

  it("throws under test/dev for an unknown credential-prefixed key", () => {
    process.env.NODE_ENV = "development";
    expect(() => assertNoForbiddenChildEnv({ CODEX_ANYTHING: "1" })).toThrow(
      ForbiddenChildEnvKeyError,
    );
    expect(() => assertNoForbiddenChildEnv({ OPENAI_ANYTHING: "1" })).toThrow(
      ForbiddenChildEnvKeyError,
    );
  });

  it("deletes rather than throws in production", () => {
    process.env.NODE_ENV = "production";
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", CODEX_ACCESS_TOKEN: SENTINEL };
    expect(assertNoForbiddenChildEnv(env)).toBe(env);
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("permits keys we deliberately introduced", () => {
    process.env.NODE_ENV = "test";
    const env = assertNoForbiddenChildEnv({ [CODEX_MCP_BEARER_ENV_NAME]: BEARER }, [
      CODEX_MCP_BEARER_ENV_NAME,
    ]);
    expect(env[CODEX_MCP_BEARER_ENV_NAME]).toBe(BEARER);
  });
});
