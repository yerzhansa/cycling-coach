import { EventEmitter } from "node:events";
import { constants, type Stats } from "node:fs";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { query as sdkQuery, SDKMessage, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCliRuntime } from "../../src/agent/claude-cli/env.js";
import {
  buildClaudeCliSpawnInvocation,
  buildQueryOptions,
  preflightWindowsMcpConfigTransform,
  spawnClaudeCliProcess,
  startGeneration,
  type SanitizedQueryOptions,
  type WindowsMcpConfigFileSystemDeps,
} from "../../src/agent/claude-cli/session.js";

const SENTINEL = "sk-ant-sentinel-session-0000";
const WORKING_DIRECTORY = "/private/tmp/enduragent-claude-test-workspace";

const RUNTIME: ClaudeCliRuntime = {
  binaryPath: "/Users/tester/.local/bin/claude",
  billing: "subscription",
};

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    USER: "tester",
    ANTHROPIC_API_KEY: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
  };
}

function fakeMetadata(kind: "directory" | "file", ino: number): Stats {
  return {
    dev: 7,
    ino,
    nlink: 1,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  } as Stats;
}

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

interface FakeWindowsMcpFileSystem {
  readonly deps: WindowsMcpConfigFileSystemDeps;
  readonly profile: string;
  readonly root: string;
  readonly temporary: string;
  readonly file: string;
  readonly mkdir: ReturnType<typeof vi.fn>;
  readonly open: ReturnType<typeof vi.fn>;
  readonly unlink: ReturnType<typeof vi.fn>;
  readonly rmdir: ReturnType<typeof vi.fn>;
  readonly written: string[];
}

function fakeWindowsMcpFileSystem(
  failure: "write" | "cleanup" | null = null,
  profile = "C:\\Users\\Rider",
): FakeWindowsMcpFileSystem {
  const root = win32.join(profile, ".enduragent");
  const temporary = win32.join(root, "claude-cli-mcp-ABC123");
  const file = win32.join(temporary, "mcp.json");
  const entries = new Map<string, Stats>([
    [win32.dirname(profile), fakeMetadata("directory", 1)],
    [profile, fakeMetadata("directory", 2)],
  ]);
  const written: string[] = [];
  const mkdir = vi.fn((path: string) => {
    expect(path).toBe(root);
    entries.set(root, fakeMetadata("directory", 3));
    return root;
  });
  const open = vi.fn((path: string) => {
    expect(path).toBe(file);
    entries.set(file, fakeMetadata("file", 5));
    return 41;
  });
  const unlink = vi.fn((path: string) => {
    expect(path).toBe(file);
    if (failure === "cleanup") throw new Error(`private ${path} ${SENTINEL}`);
    entries.delete(file);
  });
  const rmdir = vi.fn((path: string) => {
    expect(path).toBe(temporary);
    entries.delete(temporary);
  });
  const deps = {
    mkdirSync: mkdir,
    mkdtempSync: vi.fn((prefix: string) => {
      expect(prefix).toBe(win32.join(root, "claude-cli-mcp-"));
      entries.set(temporary, fakeMetadata("directory", 4));
      return temporary;
    }),
    lstatSync: vi.fn((path: string) => {
      const metadata = entries.get(path);
      if (metadata === undefined) throw missingFile();
      return metadata;
    }),
    realpathSync: vi.fn((path: string) => path),
    openSync: open,
    fstatSync: vi.fn(() => entries.get(file) ?? fakeMetadata("file", 5)),
    writeSync: vi.fn((_descriptor: number, buffer: Buffer, offset: number, length: number) => {
      if (failure === "write") throw new Error(`private ${file} ${SENTINEL}`);
      written.push(buffer.subarray(offset, offset + length).toString("utf8"));
      return length;
    }),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: unlink,
    rmdirSync: rmdir,
  } as unknown as WindowsMcpConfigFileSystemDeps;
  return { deps, profile, root, temporary, file, mkdir, open, unlink, rmdir, written };
}

function fakeSpawnedChild(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
} {
  const child = new EventEmitter() as ReturnType<typeof fakeSpawnedChild>;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function options(overrides: Partial<Parameters<typeof buildQueryOptions>[0]> = {}) {
  return buildQueryOptions({
    runtime: RUNTIME,
    baseEnv: baseEnv(),
    model: "haiku",
    cwd: WORKING_DIRECTORY,
    assertWorkingArea: () => undefined,
    ...overrides,
  });
}

interface FakeQueryState {
  calls: number;
  lastArgs: { prompt: unknown; options?: unknown } | null;
  returnCalls: number;
  interrupts: number;
}

function makeFakeQuery(messages: SDKMessage[], throwAtEnd?: unknown) {
  const state: FakeQueryState = { calls: 0, lastArgs: null, returnCalls: 0, interrupts: 0 };
  const call = (args: { prompt: unknown; options?: unknown }) => {
    state.calls += 1;
    state.lastArgs = args;
    const inner = (async function* () {
      for (const message of messages) yield message;
      if (throwAtEnd !== undefined) throw throwAtEnd;
    })();
    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      next: () => inner.next(),
      return: async (value: unknown) => {
        state.returnCalls += 1;
        return inner.return(value as undefined);
      },
      throw: (err: unknown) => inner.throw(err),
      interrupt: async () => {
        state.interrupts += 1;
        return undefined;
      },
    };
    return q;
  };
  return { query: call as unknown as typeof sdkQuery, state };
}

function systemFrame(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  } as unknown as SDKMessage;
}

function resultFrame(isError: boolean): SDKMessage {
  return {
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    session_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    total_cost_usd: 0.001,
  } as unknown as SDKMessage;
}

async function drain(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const seen: SDKMessage[] = [];
  for await (const message of iterable) seen.push(message);
  return seen;
}

describe("buildQueryOptions", () => {
  it("always pins the resolved executable and an explicit model", () => {
    const built = options();
    expect(built.pathToClaudeCodeExecutable).toBe(RUNTIME.binaryPath);
    expect(built.model).toBe("haiku");
  });

  it("supplies a sanitized, non-optional child environment", () => {
    const built: SanitizedQueryOptions = options();
    expect(built.env.PATH).toBe("/usr/bin:/bin");
    expect(built.env.HOME).toBe("/Users/tester");
    expect(built.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(built.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(built.env)).not.toContain(SENTINEL);
  });

  it("disables the hosted MCP server catalogue and filesystem settings sources", () => {
    const built = options();
    expect(built.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(built.strictMcpConfig).toBe(true);
    expect(built.settingSources).toEqual([]);
  });

  it("never permits a permission bypass", () => {
    const built = options({ tools: [], allowedTools: [] });
    expect("permissionMode" in built).toBe(false);
    expect("allowDangerouslySkipPermissions" in built).toBe(false);
    expect(JSON.stringify(built)).not.toContain("bypassPermissions");
  });

  it("passes an api-key through only when the instance opted into api-key billing", () => {
    const subscription = options();
    expect(subscription.env.ANTHROPIC_API_KEY).toBeUndefined();

    const apiKey = buildQueryOptions({
      runtime: { ...RUNTIME, billing: "api-key" },
      baseEnv: baseEnv(),
      model: "haiku",
      cwd: WORKING_DIRECTORY,
      assertWorkingArea: () => undefined,
    });
    expect(apiKey.env.ANTHROPIC_API_KEY).toBe(SENTINEL);
  });

  it("carries the optional generation knobs it was given", () => {
    const built = options({
      systemPrompt: "coach prompt",
      tools: ["mcp__coach__memory_read"],
      allowedTools: ["mcp__coach__memory_read"],
      maxTurns: 10,
      resume: "session-1",
      includePartialMessages: true,
      persistSession: false,
      cwd: "/tmp/scratch",
    });
    expect(built.systemPrompt).toBe("coach prompt");
    expect(built.tools).toEqual(["mcp__coach__memory_read"]);
    expect(built.allowedTools).toEqual(["mcp__coach__memory_read"]);
    expect(built.maxTurns).toBe(10);
    expect(built.resume).toBe("session-1");
    expect(built.includePartialMessages).toBe(true);
    expect(built.persistSession).toBe(false);
    expect(built.cwd).toBe("/tmp/scratch");
  });

  it("requires an explicit private working directory", () => {
    expect(() => options({ cwd: "" })).toThrow(
      expect.objectContaining({ kind: "working-area-unavailable" }),
    );
  });

  it("refuses an empty model", () => {
    expect(() => options({ model: "" })).toThrow(/explicit model/);
  });

  it("refuses a runtime without a resolved binary path", () => {
    expect(() => options({ runtime: { ...RUNTIME, binaryPath: "" } })).toThrow(
      /explicit resolved binary path/,
    );
  });

  it("refuses both resume and a fresh session id at once", () => {
    expect(() => options({ resume: "a", sessionId: "b" })).toThrow(/resume or sessionId/);
  });

  it("keeps a Windows .exe on the verified direct shell-disabled spawn path", () => {
    const executable = "C:\\Program Files (x86)\\Claude\\claude.exe";
    const invocation = buildClaudeCliSpawnInvocation({
      binaryPath: executable,
      args: ["--version"],
      env: { SystemRoot: "C:\\Windows" },
      platform: "win32",
    });
    expect(invocation).toEqual({
      command: executable,
      args: ["--version"],
      shell: false,
      windowsHide: true,
    });

    const built = options({
      runtime: { binaryPath: executable, billing: "subscription" },
      baseEnv: { Path: "C:\\Windows\\System32", userprofile: "C:\\Users\\Rider" },
      platform: "win32",
    });
    expect(built.spawnClaudeCodeProcess).toEqual(expect.any(Function));
  });

  it("routes a validated Windows .cmd shim through cmd.exe with explicit quoting", () => {
    const shim = "C:\\Users\\Rider Name\\AppData\\Roaming\\npm\\claude.cmd";
    const invocation = buildClaudeCliSpawnInvocation({
      binaryPath: shim,
      args: ["--output-format", "stream-json", "--model", "Claude Model", "C:\\Training\\"],
      env: { systemroot: "C:\\Windows" },
      platform: "win32",
    });
    expect(invocation).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""${shim}" "--output-format" "stream-json" "--model" "Claude Model" "C:\\Training\\\\""`,
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });

    const built = options({
      runtime: {
        binaryPath: shim,
        billing: "subscription",
        configDir: "~\\claude-config",
      },
      baseEnv: { SystemRoot: "C:\\Windows", userprofile: "C:\\Users\\Rider Name" },
      platform: "win32",
      home: "D:\\Profiles\\Rider",
    });
    expect(built.spawnClaudeCodeProcess).toEqual(expect.any(Function));
    expect(built.env.CLAUDE_CONFIG_DIR).toBe("D:\\Profiles\\Rider\\claude-config");
  });

  it("accepts Unicode Windows .cmd, argument, and system paths", () => {
    const shim = "C:\\Users\\\u9a91\u624b\\AppData\\Roaming\\npm\\claude.cmd";
    const invocation = buildClaudeCliSpawnInvocation({
      binaryPath: shim,
      args: ["--model", "\u041a\u043b\u043e\u0434 \u0421\u043e\u043d\u0435\u0442"],
      env: { SystemRoot: "D:\\\u7cfb\u7edf" },
      platform: "win32",
    });

    expect(invocation).toEqual({
      command: "D:\\\u7cfb\u7edf\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        `""${shim}" "--model" "\u041a\u043b\u043e\u0434 \u0421\u043e\u043d\u0435\u0442""`,
      ],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  });

  it("writes inline SDK MCP JSON privately and launches the .cmd shim with its file path", () => {
    const fileSystem = fakeWindowsMcpFileSystem();
    const child = fakeSpawnedChild();
    const launch = vi.fn((_command: string, _args: readonly string[], _options: object) => child);
    const shim = "C:\\Users\\Rider\\AppData\\Roaming\\npm\\claude.cmd";
    const inline = JSON.stringify({
      mcpServers: {
        coach: {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          env: { PRIVATE_TOKEN: SENTINEL },
        },
      },
    });
    const controller = new AbortController();

    const spawned = spawnClaudeCliProcess(
      {
        command: shim,
        args: ["--output-format", "stream-json", "--mcp-config", inline, "--strict-mcp-config"],
        env: { SystemRoot: "C:\\Windows", USERPROFILE: fileSystem.profile },
        cwd: "C:\\Users\\Rider\\AppData\\Local\\Enduragent\\Claude\\workspace",
        signal: controller.signal,
      },
      {
        platform: "win32",
        spawn: launch as unknown as typeof import("node:child_process").spawn,
        windowsMcpConfigFileSystem: fileSystem.deps,
      },
    );

    expect(spawned).toBe(child);
    expect(fileSystem.mkdir).toHaveBeenCalledWith(fileSystem.root, {
      recursive: true,
      mode: 0o700,
    });
    expect(fileSystem.open).toHaveBeenCalledWith(
      fileSystem.file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    expect(fileSystem.written.join("")).toBe(inline);
    const spawnedArguments = launch.mock.calls[0]?.[1] as string[] | undefined;
    const commandLine = spawnedArguments?.[3] ?? "";
    expect(commandLine).toContain(`"--mcp-config" "${fileSystem.file.replaceAll("\\", "/")}"`);
    expect(commandLine).not.toContain(inline);
    expect(commandLine).not.toContain(SENTINEL);
    expect(commandLine).not.toContain("{");
    expect(launch).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      expect.any(Array),
      expect.objectContaining({
        cwd: "C:\\Users\\Rider\\AppData\\Local\\Enduragent\\Claude\\workspace",
        shell: false,
        windowsVerbatimArguments: true,
      }),
    );

    child.emit("exit", 0, null);
    expect(fileSystem.unlink).toHaveBeenCalledOnce();
    expect(fileSystem.rmdir).toHaveBeenCalledOnce();
  });

  it("preflights a representative non-empty MCP config through the same private transform", () => {
    const fileSystem = fakeWindowsMcpFileSystem();

    preflightWindowsMcpConfigTransform({
      binaryPath: "C:\\Users\\Rider\\AppData\\Roaming\\npm\\claude.cmd",
      env: { SystemRoot: "C:\\Windows", USERPROFILE: fileSystem.profile },
      platform: "win32",
      fileSystem: fileSystem.deps,
    });

    const serialized = JSON.parse(fileSystem.written.join("")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(serialized.mcpServers ?? {})).toEqual(["enduragent-readiness"]);
    expect(fileSystem.unlink).toHaveBeenCalledOnce();
    expect(fileSystem.rmdir).toHaveBeenCalledOnce();
  });

  it("preflights the private MCP transform under a Unicode Windows profile", () => {
    const fileSystem = fakeWindowsMcpFileSystem(null, "C:\\Users\\\u9a91\u624b");

    preflightWindowsMcpConfigTransform({
      binaryPath: "C:\\Users\\\u9a91\u624b\\AppData\\Roaming\\npm\\claude.cmd",
      env: { SystemRoot: "C:\\Windows", USERPROFILE: fileSystem.profile },
      platform: "win32",
      fileSystem: fileSystem.deps,
    });

    expect(fileSystem.mkdir).toHaveBeenCalledWith(fileSystem.root, {
      recursive: true,
      mode: 0o700,
    });
    expect(fileSystem.unlink).toHaveBeenCalledOnce();
    expect(fileSystem.rmdir).toHaveBeenCalledOnce();
  });

  it("fails closed with a private stage-coded error when the MCP file write fails", () => {
    const fileSystem = fakeWindowsMcpFileSystem("write");
    const launch = vi.fn();
    const inline = JSON.stringify({
      mcpServers: { coach: { type: "stdio", command: "node", env: { TOKEN: SENTINEL } } },
    });

    const failure = (() => {
      try {
        spawnClaudeCliProcess(
          {
            command: "C:\\Users\\Rider\\AppData\\Roaming\\npm\\claude.cmd",
            args: ["--mcp-config", inline],
            env: { SystemRoot: "C:\\Windows", USERPROFILE: fileSystem.profile },
            cwd: "C:\\Users\\Rider\\AppData\\Local\\Enduragent\\Claude\\workspace",
            signal: new AbortController().signal,
          },
          {
            platform: "win32",
            spawn: launch as unknown as typeof import("node:child_process").spawn,
            windowsMcpConfigFileSystem: fileSystem.deps,
          },
        );
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toMatchObject({
      kind: "windows-mcp-config-write",
      stage: "content-write",
    });
    expect((failure as Error).message).not.toContain(fileSystem.file);
    expect((failure as Error).message).not.toContain(SENTINEL);
    expect(launch).not.toHaveBeenCalled();
    expect(fileSystem.unlink).toHaveBeenCalledOnce();
    expect(fileSystem.rmdir).toHaveBeenCalledOnce();
  });

  it("classifies cleanup failure without suppressing the child process exit", () => {
    const fileSystem = fakeWindowsMcpFileSystem("cleanup");
    const child = fakeSpawnedChild();
    const cleanupFailures = vi.fn();
    const inline = JSON.stringify({
      mcpServers: { coach: { type: "stdio", command: "node" } },
    });
    const spawned = spawnClaudeCliProcess(
      {
        command: "C:\\Users\\Rider\\AppData\\Roaming\\npm\\claude.cmd",
        args: ["--mcp-config", inline],
        env: { SystemRoot: "C:\\Windows", USERPROFILE: fileSystem.profile },
        cwd: "C:\\Users\\Rider\\AppData\\Local\\Enduragent\\Claude\\workspace",
        signal: new AbortController().signal,
      },
      {
        platform: "win32",
        spawn: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
        windowsMcpConfigFileSystem: fileSystem.deps,
        onWindowsMcpConfigCleanupFailure: cleanupFailures,
      },
    );
    const exit = vi.fn();
    spawned.on("exit", exit);

    child.emit("exit", 23, null);

    expect(exit).toHaveBeenCalledWith(23, null);
    expect(cleanupFailures).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "windows-mcp-config-cleanup", stage: "cleanup" }),
    );
    const cleanupFailure = cleanupFailures.mock.calls[0]?.[0] as Error;
    expect(cleanupFailure.message).not.toContain(fileSystem.file);
    expect(cleanupFailure.message).not.toContain(SENTINEL);
  });

  it.each([
    "C:\\Users\\Rider&Other\\npm\\claude.cmd",
    "C:\\Users\\Rider|Other\\npm\\claude.cmd",
    "C:\\Users\\Rider^Other\\npm\\claude.cmd",
    "C:\\Users\\Rider!Other\\npm\\claude.cmd",
    "C:\\Users\\Rider%TEMP%\\npm\\claude.cmd",
    "C:\\Program Files (x86)\\npm\\claude.cmd",
    'C:\\Users\\Rider"Other\\npm\\claude.cmd',
    "C:\\Users\\Rider\nOther\\npm\\claude.cmd",
    "C:\\Users\\Rider\u0000Other\\npm\\claude.cmd",
  ])("rejects an unsafe Windows .cmd path without echoing it: %s", (shim) => {
    const failure = (() => {
      try {
        buildClaudeCliSpawnInvocation({
          binaryPath: shim,
          args: ["--version"],
          env: { SystemRoot: "C:\\Windows" },
          platform: "win32",
        });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toMatchObject({ kind: "unsafe-windows-command-shim" });
    expect((failure as Error).message).not.toContain(shim);
  });

  it.each([
    ["metacharacter", "sonnet&whoami"],
    ["expansion", "%TEMP%"],
    ["delayed expansion", "sonnet!whoami"],
    ["quote", 'sonnet"whoami'],
    ["line break", "sonnet\nwhoami"],
    ["control", "sonnet\u0000whoami"],
  ])("rejects %s in Windows .cmd arguments before launch", (_case, argument) => {
    expect(() =>
      buildClaudeCliSpawnInvocation({
        binaryPath: "C:\\Users\\Rider\\npm\\claude.cmd",
        args: ["--model", argument],
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-windows-command-shim" }));
  });

  it("rejects unsafe Windows system paths", () => {
    expect(() =>
      buildClaudeCliSpawnInvocation({
        binaryPath: "C:\\Users\\Rider\\npm\\claude.cmd",
        args: ["--version"],
        env: { SystemRoot: "C:\\Win%ROOT%" },
        platform: "win32",
      }),
    ).toThrow(expect.objectContaining({ kind: "unsafe-windows-command-shim" }));
  });

  it("rejects Windows executable types other than .exe and .cmd", () => {
    expect(() =>
      buildClaudeCliSpawnInvocation({
        binaryPath: "C:\\Tools\\claude.bat",
        args: [],
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
      }),
    ).toThrow(expect.objectContaining({ kind: "unsupported-windows-executable" }));
  });

  it("forwards cancellation, kill, and exit status through the Windows cmd child", () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      killed: boolean;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const launch = vi.fn((_command: string, _args: readonly string[], spawnOptions: object) => {
      const signal = (spawnOptions as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", () => child.kill());
      return child;
    });
    const controller = new AbortController();
    const shim = "C:\\Users\\Rider Name\\AppData\\Roaming\\npm\\claude.cmd";
    const spawnOptions: SpawnOptions = {
      command: shim,
      args: ["--output-format", "stream-json"],
      cwd: "C:\\Training",
      env: { SystemRoot: "C:\\Windows" },
      signal: controller.signal,
    };

    const spawned = spawnClaudeCliProcess(spawnOptions, {
      platform: "win32",
      spawn: launch as unknown as typeof import("node:child_process").spawn,
    });
    expect(spawned).toBe(child);
    expect(launch).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `""${shim}" "--output-format" "stream-json""`],
      expect.objectContaining({
        cwd: "C:\\Training",
        shell: false,
        signal: controller.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: true,
      }),
    );

    const onExit = vi.fn();
    spawned.on("exit", onExit);
    child.emit("exit", 23, null);
    expect(onExit).toHaveBeenCalledWith(23, null);

    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe("startGeneration", () => {
  it("runs exactly one query and yields its frames in order", async () => {
    const frames = [systemFrame(), resultFrame(false)];
    const fake = makeFakeQuery(frames);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });

    const seen = await drain(generation.frames());

    expect(fake.state.calls).toBe(1);
    expect(seen).toEqual(frames);
    expect(fake.state.lastArgs?.prompt).toBe("hi");
  });

  it("retains the last result frame", async () => {
    const fake = makeFakeQuery([systemFrame(), resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await drain(generation.frames());
    expect(generation.lastResult()).toEqual(resultFrame(false));
    expect(generation.iterationError()).toBeNull();
  });

  it("survives the iterator throwing after an is_error result", async () => {
    const thrown = new Error("Claude Code returned an error result: rate limit reached");
    const fake = makeFakeQuery([systemFrame(), resultFrame(true)], thrown);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });

    const seen = await drain(generation.frames());

    expect(seen).toHaveLength(2);
    expect(generation.lastResult()).toEqual(resultFrame(true));
    expect(generation.iterationError()).toBe(thrown);
  });

  it("throws a normalized error when the iterator dies before any result", async () => {
    const thrown = new Error("Claude Code process exited with code 1");
    const fake = makeFakeQuery([systemFrame()], thrown);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });

    await expect(drain(generation.frames())).rejects.toMatchObject({ name: "NetworkError" });
    expect(generation.lastResult()).toBeNull();
  });

  it("refuses a second frame consumer", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await drain(generation.frames());
    await expect(drain(generation.frames())).rejects.toThrow(/only be consumed once/);
  });

  it("forwards interrupt to the running query", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await generation.interrupt();
    expect(fake.state.interrupts).toBe(1);
  });

  it("stops forwarding interrupt once closed", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await generation.close();
    await generation.interrupt();
    expect(fake.state.interrupts).toBe(0);
  });

  it("closes idempotently", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await generation.close();
    await generation.close();
    await generation.close();
    expect(fake.state.returnCalls).toBe(1);
  });

  it("closes the query when frame iteration ends early", async () => {
    const fake = makeFakeQuery([systemFrame(), resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    for await (const _message of generation.frames()) break;
    const afterBreak = fake.state.returnCalls;
    expect(afterBreak).toBeGreaterThanOrEqual(1);
    await generation.close();
    expect(fake.state.returnCalls).toBe(afterBreak);
  });
});
