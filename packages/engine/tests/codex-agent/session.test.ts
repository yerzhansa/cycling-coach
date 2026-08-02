import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_AUTO_DENIED_METHODS,
  CODEX_STDERR_TAIL_BYTES,
  CodexNotificationFanOut,
  CodexStderrCollector,
  appServerArgs,
  autoDenyServerRequest,
  buildCapabilities,
  buildSpawnOptions,
  isErrorLevelLine,
  startAppServer,
  stripAnsi,
  type CodexAppServerSession,
} from "../../src/agent/codex-agent/session.js";
import { createFakeCodex, type FakeCodex } from "./helpers/fake-codex.js";

const SPAWN_TIMEOUT_MS = 20_000;
const ESCAPE = String.fromCharCode(27);

function baseEnvWithSecrets(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: "en_US.UTF-8",
    CODEX_API_KEY: "sk-must-not-travel",
    CODEX_HOME: "/somewhere/private",
    OPENAI_API_KEY: "sk-also-must-not-travel",
    OPENAI_BASE_URL: "https://proxy.invalid",
    CODEX_SOMETHING_ELSE: "nope",
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the fake app-server");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("buildSpawnOptions", () => {
  it("hard-throws when the binary path is missing or empty", () => {
    expect(() => buildSpawnOptions({ binaryPath: undefined, baseEnv: {} })).toThrow(
      /explicit resolved binary path/,
    );
    expect(() => buildSpawnOptions({ binaryPath: "", baseEnv: {} })).toThrow(
      /explicit resolved binary path/,
    );
  });

  it("returns a non-optional env built from the allowlist, never a passthrough", () => {
    const options = buildSpawnOptions({
      binaryPath: "/opt/homebrew/bin/codex",
      baseEnv: baseEnvWithSecrets(),
      args: appServerArgs(["-c", 'approval_policy="never"']),
    });
    const env: NodeJS.ProcessEnv = options.env;
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH"]);
    expect(env).not.toHaveProperty("CODEX_API_KEY");
    expect(env).not.toHaveProperty("CODEX_HOME");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_BASE_URL");
    expect(env).not.toHaveProperty("CODEX_SOMETHING_ELSE");
    expect(options.args).toEqual(["app-server", "-c", 'approval_policy="never"']);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("introduces exactly the bearer variable when one is bound", () => {
    const options = buildSpawnOptions({
      binaryPath: "/opt/homebrew/bin/codex",
      baseEnv: baseEnvWithSecrets(),
      bearer: { envName: "ENDURAGENT_MCP_BEARER", token: "sentinel-token" },
    });
    expect(options.env.ENDURAGENT_MCP_BEARER).toBe("sentinel-token");
    expect(Object.keys(options.env).sort()).toEqual([
      "ENDURAGENT_MCP_BEARER",
      "HOME",
      "LANG",
      "PATH",
    ]);
  });

  it("carries the version-probe stdio shape when asked for it", () => {
    const options = buildSpawnOptions({
      binaryPath: "/opt/homebrew/bin/codex",
      baseEnv: baseEnvWithSecrets(),
      args: ["--version"],
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env).not.toHaveProperty("ENDURAGENT_MCP_BEARER");
  });
});

describe("codex handshake capabilities (AC-5)", () => {
  it("never enables the experimental api and never carries an experimental field", () => {
    const capabilities = buildCapabilities();
    expect(capabilities.experimentalApi).toBe(false);
    expect(capabilities.requestAttestation).toBe(false);
    expect(capabilities).not.toHaveProperty("optOutNotificationMethods");
    for (const forbidden of [
      "collaborationMode",
      "permissions",
      "dynamicTools",
      "multiAgentMode",
      "historyMode",
      "environments",
      "runtimeWorkspaceRoots",
      "selectedCapabilityRoots",
    ]) {
      expect(capabilities).not.toHaveProperty(forbidden);
    }
  });

  it("carries the opt-out list only when the caller asks for one", () => {
    const capabilities = buildCapabilities(["item/reasoning/textDelta"]);
    expect(capabilities).toEqual({
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: ["item/reasoning/textDelta"],
    });
  });
});

describe("codex auto-deny handlers (AC-6)", () => {
  it("answers every approval surface with the fail-closed payload", () => {
    expect(
      autoDenyServerRequest({ id: 1, method: "item/commandExecution/requestApproval" }),
    ).toEqual({ result: { decision: "decline" } });
    expect(autoDenyServerRequest({ id: 2, method: "item/fileChange/requestApproval" })).toEqual({
      result: { decision: "decline" },
    });
    expect(autoDenyServerRequest({ id: 3, method: "mcpServer/elicitation/request" })).toEqual({
      result: { action: "decline", content: null, _meta: null },
    });
    expect(autoDenyServerRequest({ id: 4, method: "item/tool/requestUserInput" })).toEqual({
      result: { answers: {} },
    });
    expect(autoDenyServerRequest({ id: 5, method: "item/permissions/requestApproval" })).toEqual({
      result: { permissions: {}, scope: "turn" },
    });
    expect(CODEX_AUTO_DENIED_METHODS).toHaveLength(5);
  });

  it("answers -32601 for any other server request", () => {
    expect(autoDenyServerRequest({ id: 6, method: "thread/definitelyNotAMethod" })).toEqual({
      error: { code: -32601, message: "Method not found: thread/definitelyNotAMethod" },
    });
  });

  it("hands out a fresh payload object per call so a caller cannot mutate the table", () => {
    const first = autoDenyServerRequest({ id: 7, method: "item/tool/requestUserInput" });
    const second = autoDenyServerRequest({ id: 8, method: "item/tool/requestUserInput" });
    expect(first).not.toBe(second);
    expect((first as { result: { answers: Record<string, unknown> } }).result.answers).not.toBe(
      (second as { result: { answers: Record<string, unknown> } }).result.answers,
    );
  });
});

describe("codex stderr consumer", () => {
  it("keeps only ERROR-level lines, stripped of ANSI and redacted", () => {
    const collector = new CodexStderrCollector();
    const kept = collector.ingest(
      `2026-08-02T09:00:00Z  INFO codex started\n` +
        `${ESCAPE}[31m2026-08-02T09:00:01Z ERROR codex::auth Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig${ESCAPE}[0m\n` +
        `2026-08-02T09:00:02Z DEBUG codex noisy\n`,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("ERROR codex::auth");
    expect(kept[0]).not.toContain(ESCAPE);
    expect(kept[0]).toContain("[redacted]");
    expect(collector.tail()).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(collector.tail()).not.toContain("INFO");
  });

  it("caps the retained tail and keeps the newest lines", () => {
    const collector = new CodexStderrCollector(256);
    for (let index = 0; index < 40; index += 1) {
      collector.ingest(`ERROR line-${index} ${"x".repeat(40)}\n`);
    }
    expect(Buffer.byteLength(collector.tail(), "utf8")).toBeLessThanOrEqual(256);
    expect(collector.tail()).toContain("line-39");
    expect(collector.tail()).not.toContain("line-0 ");
  });

  it("caps a single oversized line without looping forever", () => {
    const collector = new CodexStderrCollector(64);
    collector.ingest(`ERROR ${"y".repeat(4096)}\n`);
    expect(Buffer.byteLength(collector.tail(), "utf8")).toBeLessThanOrEqual(64);
  });

  it("flushes a trailing partial line at exit", () => {
    const collector = new CodexStderrCollector();
    expect(collector.ingest("ERROR partial without newline")).toEqual([]);
    expect(collector.flush()).toEqual(["ERROR partial without newline"]);
  });

  it("classifies levels on the ERROR token only", () => {
    expect(isErrorLevelLine("2026 ERROR codex boom")).toBe(true);
    expect(isErrorLevelLine("ERROR: boom")).toBe(true);
    expect(isErrorLevelLine("INFO recovered from an error")).toBe(false);
    expect(isErrorLevelLine("WARN ERRORS_TOTAL=3")).toBe(false);
    expect(stripAnsi(`${ESCAPE}[1;31mred${ESCAPE}[0m`)).toBe("red");
  });

  it("defaults the tail cap to 8 KB", () => {
    expect(CODEX_STDERR_TAIL_BYTES).toBe(8 * 1024);
  });
});

describe("codex notification fan-out", () => {
  it("hands the pre-subscription backlog to the first subscriber", async () => {
    const fanOut = new CodexNotificationFanOut();
    fanOut.push({ method: "turn/started" });
    fanOut.push({ method: "item/completed" });
    const collector = fanOut.subscribe();
    expect((await collector.next()).value?.method).toBe("turn/started");
    expect((await collector.next()).value?.method).toBe("item/completed");
  });

  it("delivers a live notification to every subscriber", async () => {
    const fanOut = new CodexNotificationFanOut();
    const first = fanOut.subscribe();
    const second = fanOut.subscribe();
    fanOut.push({ method: "turn/completed" });
    const [a, b] = await Promise.all([first.next(), second.next()]);
    expect(a.value?.method).toBe("turn/completed");
    expect(b.value?.method).toBe("turn/completed");
  });

  it("completes every subscriber on close and stays closed", async () => {
    const fanOut = new CodexNotificationFanOut();
    const first = fanOut.subscribe();
    fanOut.close();
    fanOut.close();
    fanOut.push({ method: "turn/completed" });
    expect(await first.next()).toEqual({ value: undefined, done: true });
    const late = fanOut.subscribe();
    expect(await late.next()).toEqual({ value: undefined, done: true });
  });
});

describe("startAppServer against the fake app-server", () => {
  let fake: FakeCodex | null = null;
  let session: CodexAppServerSession | null = null;

  afterEach(async () => {
    await session?.close();
    session = null;
    await fake?.cleanup();
    fake = null;
  });

  it(
    "completes the handshake with the exact wire shape (AC-5, AC-22)",
    async () => {
      fake = await createFakeCodex({ script: "handshake-only" });
      session = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
        configArgs: ["-c", 'approval_policy="never"'],
        clientVersion: "9.9.9",
      });

      expect(session.userAgent).toContain("codex_cli_rs/0.146.0");
      await waitFor(async () => (await fake?.readFramesIn())?.length === 2);

      const frames = await fake.readFramesIn();
      expect(frames.map((frame) => frame.method)).toEqual(["initialize", "initialized"]);
      for (const frame of frames) expect(frame).not.toHaveProperty("jsonrpc");
      expect(Object.keys(frames[1] ?? {})).toEqual(["method"]);
      expect(frames[1]).not.toHaveProperty("params");

      const params = frames[0]?.params as {
        clientInfo: Record<string, unknown>;
        capabilities: Record<string, unknown>;
      };
      expect(params.clientInfo).toEqual({
        name: "enduragent",
        title: "Enduragent",
        version: "9.9.9",
      });
      expect(params.capabilities).toEqual({ experimentalApi: false, requestAttestation: false });

      const argv = await fake.readArgv();
      expect(argv).toEqual(["app-server", "-c", 'approval_policy="never"']);
      const env = await fake.readEnv();
      expect(env).not.toHaveProperty("CODEX_API_KEY");
      expect(env).not.toHaveProperty("CODEX_HOME");
      expect(env).not.toHaveProperty("ENDURAGENT_MCP_BEARER");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "answers every server request fail-closed with the D-13 payloads (AC-6)",
    async () => {
      fake = await createFakeCodex({ script: "approvals-all-five" });
      session = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
      });

      await waitFor(async () => (await fake?.readReplies())?.length === 5);
      const replies = await fake.readReplies();
      const results = replies.map((reply) => reply.result);

      expect(results).toEqual([
        { decision: "decline" },
        { decision: "decline" },
        { action: "decline", content: null, _meta: null },
        { answers: {} },
        { permissions: {}, scope: "turn" },
      ]);
      const wire = JSON.stringify(replies);
      expect(wire).toContain('"decision":"decline"');
      expect(wire).not.toContain("denied");
      expect(wire).not.toContain("approved");
      for (const reply of replies) {
        expect(reply).not.toHaveProperty("jsonrpc");
        expect(reply).not.toHaveProperty("error");
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "answers an unknown server request with -32601 and no side effect",
    async () => {
      fake = await createFakeCodex({ script: "unknown-server-request" });
      session = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
      });

      await waitFor(async () => (await fake?.readReplies())?.length === 1);
      const replies = await fake.readReplies();
      expect(replies[0]?.error).toEqual({
        code: -32601,
        message: "Method not found: thread/definitelyNotAMethod",
      });
      expect(replies[0]).not.toHaveProperty("result");
      expect(session.client.terminated).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "survives an unsolicited notification arriving at handshake time",
    async () => {
      fake = await createFakeCodex({ script: "handshake-with-unsolicited-status" });
      const diagnostics: unknown[] = [];
      session = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      const collector = session.notifications();
      const seen: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const next = await collector.next();
        if (next.done === true) break;
        seen.push(next.value.method);
      }
      expect(seen).toEqual([
        "remoteControl/status/changed",
        "remoteControl/status/changed",
        "configWarning",
      ]);
      expect(diagnostics).toEqual([]);
      expect(session.userAgent).toContain("codex_cli_rs");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "retains only redacted ERROR-level stderr from one consumer",
    async () => {
      fake = await createFakeCodex({ script: "stderr-mixed-levels" });
      const lines: string[] = [];
      session = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
        onStderrLine: (line) => lines.push(line),
      });

      await waitFor(async () => lines.length === 1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("ERROR codex::auth");
      expect(lines[0]).not.toContain(ESCAPE);
      expect(session.stderrTail()).toContain("[redacted]");
      expect(session.stderrTail()).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(session.stderrTail()).not.toContain("INFO");
      expect(session.stderrTail()).not.toContain("DEBUG");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "closes idempotently and reports the exit once",
    async () => {
      fake = await createFakeCodex({ script: "handshake-only" });
      const started = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
      });

      const first = started.close();
      const second = started.close();
      expect(first).toBe(second);
      await Promise.all([first, second, started.close()]);

      const exit = started.exitStatus();
      expect(exit?.code).toBe(0);
      expect(started.client.terminated).toBe(true);
      expect(await fake.spawnCount()).toBe(1);
      await started.close();
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "force-kills a child that ignores the closed stdin",
    async () => {
      fake = await createFakeCodex({ script: "handshake-ignores-stdin-end" });
      const started = await startAppServer({
        binaryPath: fake.binaryPath,
        baseEnv: baseEnvWithSecrets(),
        closeGraceMs: 250,
      });

      const startedAt = Date.now();
      await started.close();
      const exit = started.exitStatus();
      expect(exit?.signal).toBe("SIGKILL");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      expect(started.client.terminated).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});
