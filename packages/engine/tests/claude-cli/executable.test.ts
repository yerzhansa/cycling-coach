import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HANG_VERSION, createFakeClaude, type FakeClaude } from "./helpers/fake-claude.js";
import {
  CLAUDE_CLI_VERSION_FLOOR,
  assertVersionAtLeast,
  compareVersions,
  parseClaudeVersion,
  probeVersion as probeVersionImpl,
  resolveClaudeBinary,
  wellKnownClaudePaths,
} from "../../src/agent/claude-cli/executable.js";
import { ClaudeCliConfigError } from "../../src/agent/claude-cli/errors.js";
import type { ClaudeWorkingAreaPort } from "../../src/agent/claude-cli/working-area.js";
import { fixedClaudeWorkingArea } from "./helpers/working-area.js";

const SENTINEL = "sk-ant-sentinel-executable-0000";

const cleanups: Array<() => Promise<void>> = [];
let fake: FakeClaude | null = null;

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
    ANTHROPIC_API_KEY: SENTINEL,
    ANTHROPIC_AUTH_TOKEN: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
  };
}

function onlyExecutable(match: string) {
  return async (candidate: string) => candidate === match;
}

type TestProbeVersionOptions = Omit<Parameters<typeof probeVersionImpl>[1], "workingArea"> & {
  workingArea?: ClaudeWorkingAreaPort;
};

function probeVersion(binaryPath: string, options: TestProbeVersionOptions) {
  return probeVersionImpl(binaryPath, {
    ...options,
    workingArea: options.workingArea ?? fixedClaudeWorkingArea(tmpdir()),
  });
}

function fakeVersionSpawn(stdoutText: string, exitCode: number, stderrText = "") {
  const launch = vi.fn((_command: string, _args: readonly string[], _options: object) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      child.stdout.end(stdoutText);
      child.stderr.end(stderrText);
      child.emit("close", exitCode, null);
    });
    return child;
  });
  return {
    launch,
    spawn: launch as unknown as typeof import("node:child_process").spawn,
  };
}

describe("resolveClaudeBinary", () => {
  it("prefers the explicit path over anything on PATH", async () => {
    const resolved = await resolveClaudeBinary({
      explicitPath: "/explicit/claude",
      env: { PATH: "/custom/bin", HOME: "/Users/tester" },
      isExecutable: onlyExecutable("/custom/bin/claude"),
    });
    expect(resolved).toBe("/explicit/claude");
  });

  it("expands a tilde in the explicit path", async () => {
    const resolved = await resolveClaudeBinary({
      explicitPath: "~/bin/claude",
      env: { PATH: "", HOME: "/Users/tester" },
      isExecutable: async () => false,
    });
    expect(resolved).toBe(join(homedir(), "bin", "claude"));
  });

  it("resolves from PATH in entry order", async () => {
    const resolved = await resolveClaudeBinary({
      env: { PATH: "/first/bin:/second/bin", HOME: "/Users/tester" },
      isExecutable: async (candidate) =>
        candidate === "/second/bin/claude" || candidate === "/first/bin/claude",
    });
    expect(resolved).toBe("/first/bin/claude");
  });

  for (const location of wellKnownClaudePaths("/Users/tester")) {
    it(`falls back to the well-known location ${location}`, async () => {
      const resolved = await resolveClaudeBinary({
        env: { PATH: "/usr/bin:/bin", HOME: "/Users/tester" },
        home: "/Users/tester",
        isExecutable: onlyExecutable(location),
      });
      expect(resolved).toBe(location);
    });
  }

  it("returns null when PATH and every well-known location miss", async () => {
    const resolved = await resolveClaudeBinary({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/tester" },
      home: "/Users/tester",
      isExecutable: async () => false,
    });
    expect(resolved).toBeNull();
  });

  it("probes Windows PATH entries in order with .exe before .cmd and never probes a bare name", async () => {
    const seen: string[] = [];
    const expected = "D:\\Second\\claude.exe";
    const resolved = await resolveClaudeBinary({
      platform: "win32",
      env: { Path: "C:\\First;D:\\Second", userprofile: "C:\\Users\\Rider" },
      isExecutable: async (candidate) => {
        seen.push(candidate);
        return candidate === expected;
      },
    });

    expect(resolved).toBe(expected);
    expect(seen).toEqual([
      "C:\\First\\claude.exe",
      "C:\\First\\claude.cmd",
      "D:\\Second\\claude.exe",
    ]);
    expect(seen).not.toContain("C:\\First\\claude");
  });

  it("uses explicit current Windows native, WinGet, and npm-shim locations", () => {
    expect(
      wellKnownClaudePaths("C:\\Users\\Rider", {
        platform: "win32",
        env: {
          LocalAppData: "D:\\Profiles\\Rider\\Local",
          appdata: "D:\\Profiles\\Rider\\Roaming",
        },
      }),
    ).toEqual([
      "C:\\Users\\Rider\\.local\\bin\\claude.exe",
      "D:\\Profiles\\Rider\\Local\\Microsoft\\WinGet\\Links\\claude.exe",
      "D:\\Profiles\\Rider\\Roaming\\npm\\claude.cmd",
    ]);
  });

  it("honors USERPROFILE and enforces existence plus .exe-or-.cmd for explicit Windows paths", async () => {
    const checker = vi.fn(async () => true);
    const resolved = await resolveClaudeBinary({
      explicitPath: "~\\bin\\claude.cmd",
      platform: "win32",
      env: { userprofile: "C:\\Users\\Rider", Path: "" },
      isExecutable: checker,
    });
    expect(resolved).toBe(win32.join("C:\\Users\\Rider", "bin", "claude.cmd"));
    expect(checker).toHaveBeenCalledOnce();

    checker.mockClear();
    await expect(
      resolveClaudeBinary({
        explicitPath: "C:\\Tools\\claude.ps1",
        platform: "win32",
        env: { userprofile: "C:\\Users\\Rider", Path: "" },
        isExecutable: checker,
      }),
    ).resolves.toBeNull();
    expect(checker).not.toHaveBeenCalled();
  });
});

describe("version parsing and floor", () => {
  it("pins the floor at the spike-validated release", () => {
    expect(CLAUDE_CLI_VERSION_FLOOR).toBe("2.1.220");
  });

  it("parses the version out of the CLI banner", () => {
    expect(parseClaudeVersion("2.1.220 (Claude Code)\n")).toBe("2.1.220");
    expect(parseClaudeVersion("no version here")).toBeNull();
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("2.1.220", "2.1.99")).toBe(1);
    expect(compareVersions("2.1.220", "2.1.220")).toBe(0);
    expect(compareVersions("2.0.999", "2.1.0")).toBe(-1);
  });

  it("accepts a version at or above the floor", () => {
    expect(() => assertVersionAtLeast("2.1.220")).not.toThrow();
    expect(() => assertVersionAtLeast("3.0.0")).not.toThrow();
  });

  it("rejects a version below the floor with the upgrade advisory", () => {
    try {
      assertVersionAtLeast("2.0.5");
      expect.unreachable("expected the floor assertion to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliConfigError);
      expect((err as ClaudeCliConfigError).kind).toBe("version-below-floor");
      expect((err as Error).message).toBe(
        "Claude Code CLI 2.0.5 is older than the minimum supported 2.1.220. Run: claude update",
      );
    }
  });
});

describe("probeVersion", () => {
  it("reads the version from the CLI and passes only --version", async () => {
    fake = await createFakeClaude({ version: "2.1.220" });
    const version = await probeVersion(fake.binaryPath, { baseEnv: baseEnvWithSecrets() });
    expect(version).toBe("2.1.220");
    expect(await fake.readArgv()).toEqual(["--version"]);
    expect(await fake.readCwds()).toEqual([await realpath(tmpdir())]);
  });

  it("spawns with a sanitized child environment", async () => {
    fake = await createFakeClaude({ version: "2.1.220" });
    await probeVersion(fake.binaryPath, { baseEnv: baseEnvWithSecrets() });
    const childEnv = await fake.readEnv();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain(SENTINEL);
    expect(childEnv.PATH).toBeDefined();
  });

  it("reports a missing binary with the install and launchd guidance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-missing-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const missing = join(dir, "claude");
    try {
      await probeVersion(missing, { baseEnv: baseEnvWithSecrets() });
      expect.unreachable("expected a missing-binary failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliConfigError);
      expect((err as ClaudeCliConfigError).kind).toBe("binary-missing");
      const message = (err as Error).message;
      expect(message).toContain(`Claude Code CLI not found at ${missing}.`);
      expect(message).toContain("https://claude.com/claude-code");
      expect(message).toContain("llm.claude_cli.binary_path");
      expect(message).toContain("Mac launchd users");
    }
  });

  it("kills and reports a hung version probe", async () => {
    fake = await createFakeClaude({ version: HANG_VERSION });
    try {
      await probeVersion(fake.binaryPath, { baseEnv: baseEnvWithSecrets(), timeoutMs: 400 });
      expect.unreachable("expected the probe to time out");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliConfigError);
      expect((err as ClaudeCliConfigError).kind).toBe("probe-timeout");
      expect((err as Error).message).toContain("timed out after 400ms");
    }
  });

  it("surfaces a stderr tail on a non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-broken-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const broken = join(dir, "claude");
    await writeFile(broken, "#!/bin/sh\necho 'boom from the cli' 1>&2\nexit 3\n", { mode: 0o755 });
    try {
      await probeVersion(broken, { baseEnv: baseEnvWithSecrets() });
      expect.unreachable("expected a non-zero exit failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliConfigError);
      expect((err as Error).message).toContain("exited with code 3");
      expect((err as Error).message).toContain("boom from the cli");
    }
  });

  it("rejects output that carries no version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-silent-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const silent = join(dir, "claude");
    await writeFile(silent, "#!/bin/sh\necho 'hello'\n", { mode: 0o755 });
    await expect(probeVersion(silent, { baseEnv: baseEnvWithSecrets() })).rejects.toThrow(
      /did not report a version/,
    );
  });

  it("does not spawn when the private working area cannot be prepared", async () => {
    const launch = vi.fn();
    const workingArea: ClaudeWorkingAreaPort = {
      cacheKey: "unavailable-test-working-area",
      prepareForLaunch: vi.fn(async () => {
        throw new Error("working area unavailable");
      }),
    };

    await expect(
      probeVersion("/opt/claude", {
        baseEnv: baseEnvWithSecrets(),
        workingArea,
        spawn: launch,
      }),
    ).rejects.toThrow("working area unavailable");
    expect(launch).not.toHaveBeenCalled();
  });

  it("probes a Windows .cmd shim through cmd.exe with shell disabled", async () => {
    const shim = "C:\\Users\\Rider Name\\AppData\\Roaming\\npm\\claude.cmd";
    const fakeSpawn = fakeVersionSpawn("2.1.220 (Claude Code)\n", 0);

    await expect(
      probeVersion(shim, {
        platform: "win32",
        baseEnv: { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
        spawn: fakeSpawn.spawn,
      }),
    ).resolves.toBe("2.1.220");
    expect(fakeSpawn.launch).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `""${shim}" "--version""`],
      expect.objectContaining({
        cwd: tmpdir(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      }),
    );
  });

  it("maps a non-zero Windows cmd exit without exposing paths or stderr", async () => {
    const shim = "C:\\Users\\Private Rider\\AppData\\Roaming\\npm\\claude.cmd";
    const privateDiagnostic = "C:\\Users\\Private Rider\\token-store";
    const fakeSpawn = fakeVersionSpawn("", 7, privateDiagnostic);

    const failure = await probeVersion(shim, {
      platform: "win32",
      baseEnv: { SystemRoot: "C:\\Windows" },
      spawn: fakeSpawn.spawn,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "binary-missing" });
    expect((failure as Error).message).toContain("exited with code 7");
    expect((failure as Error).message).not.toContain(shim);
    expect((failure as Error).message).not.toContain(privateDiagnostic);
  });
});
