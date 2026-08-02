import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { HANG_VERSION, createFakeCodex, type FakeCodex } from "./helpers/fake-codex.js";
import {
  assertVersionAtLeast,
  expandTilde,
  nvmCodexRoot,
  parseCodexVersion,
  probeVersion,
  resolveCodexBinary,
  wellKnownCodexPaths,
} from "../../src/agent/codex-agent/executable.js";
import { CodexAgentConfigError } from "../../src/agent/codex-agent/errors.js";
import { CODEX_SCHEMA_PIN, CODEX_VERSION_FLOOR } from "../../src/agent/codex-agent/version.js";

const SENTINEL = "codex-sentinel-executable-0000";

const cleanups: Array<() => Promise<void>> = [];
let fake: FakeCodex | null = null;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (fake !== null) {
    await fake.cleanup();
    fake = null;
  }
});

function baseEnvWithSecrets(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER ?? "tester",
    CODEX_API_KEY: SENTINEL,
    CODEX_ACCESS_TOKEN: SENTINEL,
    CODEX_HOME: "/Users/tester/.codex",
    OPENAI_API_KEY: SENTINEL,
    OPENAI_BASE_URL: "https://proxy.example/v1",
  };
}

function onlyExecutable(match: string) {
  return async (candidate: string) => candidate === match;
}

describe("resolveCodexBinary", () => {
  it("prefers the explicit path over anything on PATH", async () => {
    const resolved = await resolveCodexBinary({
      explicitPath: "/explicit/codex",
      env: { PATH: "/custom/bin", HOME: "/Users/tester" },
      isExecutable: onlyExecutable("/custom/bin/codex"),
    });
    expect(resolved).toBe("/explicit/codex");
  });

  it("expands a tilde in the explicit path", async () => {
    const resolved = await resolveCodexBinary({
      explicitPath: "~/bin/codex",
      env: { PATH: "", HOME: "/Users/tester" },
      isExecutable: async () => false,
    });
    expect(resolved).toBe(join(homedir(), "bin", "codex"));
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("/absolute/codex")).toBe("/absolute/codex");
  });

  it("resolves a relative explicit path to an absolute one", async () => {
    const resolved = await resolveCodexBinary({
      explicitPath: "relative/codex",
      env: { PATH: "", HOME: "/Users/tester" },
      isExecutable: async () => false,
    });
    expect(resolved?.startsWith("/")).toBe(true);
    expect(resolved?.endsWith("relative/codex")).toBe(true);
  });

  it("resolves from PATH in entry order", async () => {
    const resolved = await resolveCodexBinary({
      env: { PATH: "/first/bin:/second/bin", HOME: "/Users/tester" },
      isExecutable: async (candidate) =>
        candidate === "/second/bin/codex" || candidate === "/first/bin/codex",
    });
    expect(resolved).toBe("/first/bin/codex");
  });

  for (const location of wellKnownCodexPaths("/Users/tester")) {
    it(`falls back to the well-known location ${location}`, async () => {
      const resolved = await resolveCodexBinary({
        env: { PATH: "/usr/bin:/bin", HOME: "/Users/tester" },
        home: "/Users/tester",
        isExecutable: onlyExecutable(location),
      });
      expect(resolved).toBe(location);
    });
  }

  it("finds an nvm-installed codex through the version glob", async () => {
    const root = nvmCodexRoot("/Users/tester");
    const resolved = await resolveCodexBinary({
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/tester" },
      home: "/Users/tester",
      isExecutable: onlyExecutable(join(root, "v24.11.1", "bin", "codex")),
      listDirectory: async (directory) => (directory === root ? ["v22.9.0", "v24.11.1"] : []),
    });
    expect(resolved).toBe(join(root, "v24.11.1", "bin", "codex"));
  });

  it("prefers the newest nvm node version when several carry codex", async () => {
    const root = nvmCodexRoot("/Users/tester");
    const resolved = await resolveCodexBinary({
      env: { PATH: "", HOME: "/Users/tester" },
      home: "/Users/tester",
      isExecutable: async (candidate) => candidate.startsWith(root),
      listDirectory: async (directory) =>
        directory === root ? ["v20.9.0", "v24.11.1", "v9.11.0"] : [],
    });
    expect(resolved).toBe(join(root, "v24.11.1", "bin", "codex"));
  });

  it("returns null when PATH, the well-known locations and nvm all miss", async () => {
    const resolved = await resolveCodexBinary({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/tester" },
      home: "/Users/tester",
      isExecutable: async () => false,
      listDirectory: async () => ["v24.11.1"],
    });
    expect(resolved).toBeNull();
  });
});

describe("version parsing and floor", () => {
  it("pins the floor at the first release carrying bearer_token_env_var", () => {
    expect(CODEX_VERSION_FLOOR).toBe("0.46.0");
    expect(CODEX_SCHEMA_PIN).toBe("0.146.0");
  });

  it("parses the version out of the CLI banner", () => {
    expect(parseCodexVersion("codex-cli 0.146.0\n")).toBe("0.146.0");
    expect(parseCodexVersion("codex-cli 0.147.0-alpha.4\n")).toBe("0.147.0-alpha.4");
    expect(parseCodexVersion("no version here")).toBeNull();
  });

  it("accepts a version at or above the floor", () => {
    expect(() => assertVersionAtLeast("0.46.0")).not.toThrow();
    expect(() => assertVersionAtLeast("0.146.0")).not.toThrow();
    expect(() => assertVersionAtLeast("1.0.0")).not.toThrow();
  });

  it("rejects a version below the floor with the upgrade advisory", () => {
    try {
      assertVersionAtLeast("0.45.9");
      expect.unreachable("expected the floor assertion to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAgentConfigError);
      expect((err as CodexAgentConfigError).kind).toBe("version-below-floor");
      expect((err as Error).message).toBe(
        "Codex CLI 0.45.9 is older than the minimum supported 0.46.0. Update codex.",
      );
    }
  });

  it("treats a prerelease of the floor as below it", () => {
    expect(() => assertVersionAtLeast("0.46.0-alpha.1")).toThrow(CodexAgentConfigError);
  });
});

describe("probeVersion", () => {
  it("reads the version from the CLI and passes only --version", async () => {
    fake = await createFakeCodex({ version: "0.146.0" });
    const version = await probeVersion(fake.binaryPath, { baseEnv: baseEnvWithSecrets() });
    expect(version).toBe("0.146.0");
    expect(await fake.readArgv()).toEqual(["--version"]);
  });

  it("spawns the version probe with a sanitized, bearer-free child environment", async () => {
    fake = await createFakeCodex({ version: "0.146.0" });
    await probeVersion(fake.binaryPath, { baseEnv: baseEnvWithSecrets() });
    const childEnv = await fake.readEnv();
    expect(childEnv.CODEX_API_KEY).toBeUndefined();
    expect(childEnv.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(childEnv.CODEX_HOME).toBeUndefined();
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
    expect(childEnv.OPENAI_BASE_URL).toBeUndefined();
    expect(childEnv.ENDURAGENT_MCP_BEARER).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain(SENTINEL);
    expect(childEnv.PATH).toBeDefined();
  });

  it("reports a missing binary with the install and launchd guidance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-missing-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const missing = join(dir, "codex");
    try {
      await probeVersion(missing, { baseEnv: baseEnvWithSecrets() });
      expect.unreachable("expected a missing-binary failure");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAgentConfigError);
      expect((err as CodexAgentConfigError).kind).toBe("binary-missing");
      const message = (err as Error).message;
      expect(message).toContain(`Codex CLI not found at ${missing}.`);
      expect(message).toContain("codex login");
      expect(message).toContain("llm.codex_agent.binary_path");
      expect(message).toContain("Mac launchd users");
    }
  });

  it("kills and reports a hung version probe", async () => {
    fake = await createFakeCodex({ version: HANG_VERSION });
    try {
      await probeVersion(fake.binaryPath, { baseEnv: baseEnvWithSecrets(), timeoutMs: 400 });
      expect.unreachable("expected the probe to time out");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAgentConfigError);
      expect((err as CodexAgentConfigError).kind).toBe("probe-timeout");
      expect((err as Error).message).toContain("timed out after 400ms");
    }
  });

  it("surfaces a redacted stderr tail on a non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-broken-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const broken = join(dir, "codex");
    await writeFile(
      broken,
      "#!/bin/sh\necho 'boom: Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaaaaaaaaaaaaa.bbbb' 1>&2\nexit 3\n",
      { mode: 0o755 },
    );
    try {
      await probeVersion(broken, { baseEnv: baseEnvWithSecrets() });
      expect.unreachable("expected a non-zero exit failure");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAgentConfigError);
      const message = (err as Error).message;
      expect(message).toContain("exited with code 3");
      expect(message).toContain("boom");
      expect(message).toContain("[redacted]");
      expect(message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    }
  });

  it("rejects output that carries no version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-silent-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const silent = join(dir, "codex");
    await writeFile(silent, "#!/bin/sh\necho 'hello'\n", { mode: 0o755 });
    await expect(probeVersion(silent, { baseEnv: baseEnvWithSecrets() })).rejects.toThrow(
      /did not report a version/,
    );
  });
});
