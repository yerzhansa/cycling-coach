import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CHILD_ENV_ALLOWLIST,
  FORBIDDEN_ENV_KEYS,
  ForbiddenChildEnvKeyError,
  assertNoForbiddenChildEnv,
  buildChildEnv,
  type ClaudeCliRuntime,
} from "../../src/agent/claude-cli/env.js";

const SENTINEL = "sk-ant-sentinel-do-not-leak-0000";

const SUBSCRIPTION: ClaudeCliRuntime = {
  binaryPath: "/opt/homebrew/bin/claude",
  billing: "subscription",
};

const API_KEY_MODE: ClaudeCliRuntime = {
  binaryPath: "/opt/homebrew/bin/claude",
  billing: "api-key",
};

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
    ANTHROPIC_API_KEY: SENTINEL,
    ANTHROPIC_AUTH_TOKEN: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
    AWS_BEARER_TOKEN_BEDROCK: SENTINEL,
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    ANTHROPIC_VERTEX_PROJECT_ID: "proj",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_API_KEY: SENTINEL,
    ANTHROPIC_SOMETHING_NEW: SENTINEL,
    CLAUDE_CODE_FUTURE_FLAG: "1",
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
  it("copies exactly the allowlisted keys that exist in the parent", () => {
    const env = buildChildEnv(pollutedBase(), SUBSCRIPTION);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.USER).toBe("tester");
    expect(env.LOGNAME).toBe("tester");
    expect(env.TMPDIR).toBe("/var/folders/tmp/");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.RANDOM_UNRELATED).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("carries proxy plumbing and the extra CA bundle", () => {
    const env = buildChildEnv(
      pollutedBase({
        HTTP_PROXY: "http://proxy:3128",
        HTTPS_PROXY: "http://proxy:3129",
        NO_PROXY: "localhost",
        http_proxy: "http://proxy:3128",
        https_proxy: "http://proxy:3129",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      }),
      SUBSCRIPTION,
    );
    expect(env.HTTP_PROXY).toBe("http://proxy:3128");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3129");
    expect(env.NO_PROXY).toBe("localhost");
    expect(env.http_proxy).toBe("http://proxy:3128");
    expect(env.https_proxy).toBe("http://proxy:3129");
    expect(env.no_proxy).toBe("localhost");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp.pem");
  });

  it("carries the Linux desktop XDG directories", () => {
    const env = buildChildEnv(
      pollutedBase({
        XDG_CONFIG_HOME: "/home/tester/.config",
        XDG_DATA_HOME: "/home/tester/.local/share",
        XDG_CACHE_HOME: "/home/tester/.cache",
      }),
      SUBSCRIPTION,
    );
    expect(env.XDG_CONFIG_HOME).toBe("/home/tester/.config");
    expect(env.XDG_DATA_HOME).toBe("/home/tester/.local/share");
    expect(env.XDG_CACHE_HOME).toBe("/home/tester/.cache");
  });

  it("omits allowlisted keys that are absent from the parent instead of defining them empty", () => {
    const env = buildChildEnv({ PATH: "/usr/bin", HOME: "/Users/tester" }, SUBSCRIPTION);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  it("keeps every allowlist entry unique", () => {
    expect(new Set(CHILD_ENV_ALLOWLIST).size).toBe(CHILD_ENV_ALLOWLIST.length);
  });

  it("never sets or modifies HOME", () => {
    const env = buildChildEnv(pollutedBase(), { ...SUBSCRIPTION, configDir: "/custom/claude" });
    expect(env.HOME).toBe("/Users/tester");
  });
});

describe("buildChildEnv forbidden keys", () => {
  it("drops every forbidden credential variable in subscription mode", () => {
    const env = buildChildEnv(pollutedBase(), SUBSCRIPTION);
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("drops unknown credential-prefixed variables", () => {
    const env = buildChildEnv(pollutedBase(), SUBSCRIPTION);
    expect(env.ANTHROPIC_SOMETHING_NEW).toBeUndefined();
    expect(env.CLAUDE_CODE_FUTURE_FLAG).toBeUndefined();
  });

  it("leaks no sentinel-valued secret in subscription mode", () => {
    const env = buildChildEnv(pollutedBase(), SUBSCRIPTION);
    expect(JSON.stringify(env)).not.toContain(SENTINEL);
  });

  it("passes ANTHROPIC_API_KEY through only in api-key billing mode", () => {
    const subscription = buildChildEnv(pollutedBase(), SUBSCRIPTION);
    expect(subscription.ANTHROPIC_API_KEY).toBeUndefined();

    const apiKey = buildChildEnv(pollutedBase(), API_KEY_MODE);
    expect(apiKey.ANTHROPIC_API_KEY).toBe(SENTINEL);
  });

  it("still drops every other forbidden variable in api-key billing mode", () => {
    const env = buildChildEnv(pollutedBase(), API_KEY_MODE);
    for (const key of FORBIDDEN_ENV_KEYS) {
      if (key === "ANTHROPIC_API_KEY") continue;
      expect(env[key], key).toBeUndefined();
    }
    expect(env.ANTHROPIC_SOMETHING_NEW).toBeUndefined();
  });

  it("does not invent ANTHROPIC_API_KEY when the parent has none", () => {
    const base = pollutedBase();
    delete base.ANTHROPIC_API_KEY;
    const env = buildChildEnv(base, API_KEY_MODE);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("assertNoForbiddenChildEnv", () => {
  it("throws under test/dev when a forbidden key reaches the child env", () => {
    process.env.NODE_ENV = "test";
    expect(() => assertNoForbiddenChildEnv({ ANTHROPIC_AUTH_TOKEN: SENTINEL })).toThrow(
      ForbiddenChildEnvKeyError,
    );
  });

  it("throws under test/dev for an unknown credential-prefixed key", () => {
    process.env.NODE_ENV = "development";
    expect(() => assertNoForbiddenChildEnv({ CLAUDE_CODE_ANYTHING: "1" })).toThrow(
      ForbiddenChildEnvKeyError,
    );
  });

  it("deletes rather than throws in production", () => {
    process.env.NODE_ENV = "production";
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: SENTINEL };
    expect(assertNoForbiddenChildEnv(env)).toBe(env);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("permits keys we deliberately introduced", () => {
    process.env.NODE_ENV = "test";
    const env = assertNoForbiddenChildEnv({ ANTHROPIC_API_KEY: SENTINEL }, ["ANTHROPIC_API_KEY"]);
    expect(env.ANTHROPIC_API_KEY).toBe(SENTINEL);
  });
});

describe("CLAUDE_CONFIG_DIR matrix", () => {
  it("uses the configured directory when set and the parent also has one", () => {
    const env = buildChildEnv(pollutedBase({ CLAUDE_CONFIG_DIR: "/parent/claude" }), {
      ...SUBSCRIPTION,
      configDir: "/yaml/claude",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/yaml/claude");
  });

  it("uses the configured directory when set and the parent has none", () => {
    const env = buildChildEnv(pollutedBase(), { ...SUBSCRIPTION, configDir: "/yaml/claude" });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/yaml/claude");
  });

  it("inherits the parent value when nothing is configured", () => {
    const env = buildChildEnv(pollutedBase({ CLAUDE_CONFIG_DIR: "/parent/claude" }), SUBSCRIPTION);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/parent/claude");
  });

  it("leaves the variable absent when neither side sets it", () => {
    const env = buildChildEnv(pollutedBase(), SUBSCRIPTION);
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("expands a tilde in the configured directory", () => {
    const env = buildChildEnv(pollutedBase(), { ...SUBSCRIPTION, configDir: "~/claude-alt" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), "claude-alt"));
  });

  it("resolves a relative configured directory to an absolute path", () => {
    const env = buildChildEnv(pollutedBase(), { ...SUBSCRIPTION, configDir: "relative/claude" });
    expect(env.CLAUDE_CONFIG_DIR?.startsWith("/")).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR?.endsWith("relative/claude")).toBe(true);
  });
});
