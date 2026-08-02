import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_METHOD_NOT_FOUND,
  CodexProcessExitError,
  CodexProtocolClient,
  CodexRequestError,
  type CodexNotification,
  type CodexProtocolDiagnostic,
  type CodexServerRequest,
  type CodexServerRequestOutcome,
} from "../../src/agent/codex-agent/protocol.js";
import { createFakeCodex, type FakeCodex } from "./helpers/fake-codex.js";

const SPAWN_TIMEOUT_MS = 20_000;

interface Harness {
  client: CodexProtocolClient;
  sent: Array<Record<string, unknown>>;
  raw: string[];
  diagnostics: CodexProtocolDiagnostic[];
}

function harness(
  overrides: {
    onServerRequest?: (
      request: CodexServerRequest,
    ) => Promise<CodexServerRequestOutcome> | CodexServerRequestOutcome;
    redactStderrTail?: (text: string) => string;
    send?: (line: string) => void;
  } = {},
): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const diagnostics: CodexProtocolDiagnostic[] = [];
  const client = new CodexProtocolClient({
    send:
      overrides.send ??
      ((line) => {
        raw.push(line);
        sent.push(JSON.parse(line.trim()) as Record<string, unknown>);
      }),
    onServerRequest: overrides.onServerRequest,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    redactStderrTail: overrides.redactStderrTail,
  });
  return { client, sent, raw, diagnostics };
}

async function drain(client: CodexProtocolClient, count: number): Promise<CodexNotification[]> {
  const out: CodexNotification[] = [];
  for (let i = 0; i < count; i++) {
    const next = await client.notifications.next();
    if (next.done === true) break;
    out.push(next.value);
  }
  return out;
}

describe("codex protocol framing", () => {
  it("writes one message per line with no jsonrpc field", () => {
    const { client, sent, raw } = harness();
    void client.request("account/read", {});
    client.notify("initialized");
    expect(raw).toHaveLength(2);
    for (const line of raw) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1).includes("\n")).toBe(false);
    }
    for (const message of sent) expect(message).not.toHaveProperty("jsonrpc");
  });

  it("omits the params key entirely when there is no payload", () => {
    const { client, sent } = harness();
    client.notify("initialized");
    void client.request("config/mcpServer/reload");
    expect(Object.keys(sent[0] ?? {})).toEqual(["method"]);
    expect(Object.keys(sent[1] ?? {})).toEqual(["id", "method"]);
    expect(sent[0]).not.toHaveProperty("params");
    expect(sent[1]).not.toHaveProperty("params");
  });

  it("assigns monotonic integer ids from 1", () => {
    const { client, sent } = harness();
    void client.request("account/read", {});
    void client.request("model/list", {});
    void client.request("config/read", { includeLayers: false });
    expect(sent.map((message) => message.id)).toEqual([1, 2, 3]);
  });

  it("reassembles messages split across chunk boundaries", async () => {
    const { client } = harness();
    const pending = client.request("account/read", {});
    client.ingest('{"id":1,"resu');
    client.ingest('lt":{"requiresOpenaiAuth":false}}\n');
    await expect(pending).resolves.toEqual({ requiresOpenaiAuth: false });
  });

  it("reassembles multi-byte characters split across buffer chunks", async () => {
    const { client } = harness();
    const pending = client.request("account/read", {});
    const bytes = Buffer.from('{"id":1,"result":{"email":"é@example.test"}}\n', "utf8");
    const split = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
    client.ingest(bytes.subarray(0, split));
    client.ingest(bytes.subarray(split));
    await expect(pending).resolves.toEqual({ email: "é@example.test" });
  });

  it("strips trailing carriage returns and skips whitespace-only lines", async () => {
    const { client, diagnostics } = harness();
    const pending = client.request("account/read", {});
    client.ingest('\n   \n{"id":1,"result":{"ok":true}}\r\n\n');
    await expect(pending).resolves.toEqual({ ok: true });
    expect(diagnostics).toEqual([]);
  });
});

describe("codex protocol routing", () => {
  it("routes a response back to its pending request", async () => {
    const { client } = harness();
    const pending = client.request<{ userAgent: string }>("initialize", {});
    client.ingest('{"id":1,"result":{"userAgent":"codex_cli_rs/0.146.0"}}\n');
    await expect(pending).resolves.toEqual({ userAgent: "codex_cli_rs/0.146.0" });
    expect(client.pendingRequestCount).toBe(0);
  });

  it("correlates a response whose id is echoed with a different type", async () => {
    const { client } = harness();
    const pending = client.request("initialize", {});
    client.ingest('{"id":"1","result":{"echoed":"as-string"}}\n');
    await expect(pending).resolves.toEqual({ echoed: "as-string" });
  });

  it("rejects a pending request when the server answers with an error", async () => {
    const { client } = harness();
    const pending = client.request("thread/start", {});
    client.ingest(
      '{"id":1,"error":{"code":-32600,"message":"Invalid request: unknown variant"}}\n',
    );
    await expect(pending).rejects.toMatchObject({
      name: "CodexRequestError",
      code: -32600,
      method: "thread/start",
    });
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(CodexRequestError);
    });
  });

  it("routes notifications to the collector", async () => {
    const { client } = harness();
    client.ingest(
      '{"method":"turn/started","params":{"threadId":"t1"}}\n' +
        '{"method":"turn/completed","params":{"threadId":"t1"}}\n',
    );
    const notifications = await drain(client, 2);
    expect(notifications.map((n) => n.method)).toEqual(["turn/started", "turn/completed"]);
    expect(notifications[0]?.params).toEqual({ threadId: "t1" });
  });

  it("answers a server request through the handler", async () => {
    const seen: string[] = [];
    const { client, sent } = harness({
      onServerRequest: (request) => {
        seen.push(request.method);
        return { result: { decision: "decline" } };
      },
    });
    client.ingest(
      '{"id":7,"method":"item/commandExecution/requestApproval","params":{"itemId":"i1"}}\n',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["item/commandExecution/requestApproval"]);
    expect(sent).toEqual([{ id: 7, result: { decision: "decline" } }]);
  });

  it("answers -32601 when no server-request handler is registered", async () => {
    const { client, sent } = harness();
    client.ingest('{"id":8,"method":"thread/definitelyNotAMethod","params":{}}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([
      {
        id: 8,
        error: {
          code: CODEX_METHOD_NOT_FOUND,
          message: "Method not found: thread/definitelyNotAMethod",
        },
      },
    ]);
  });

  it("answers an internal error when the handler throws, and keeps reading", async () => {
    const { client, sent, diagnostics } = harness({
      onServerRequest: () => {
        throw new Error("boom");
      },
    });
    client.ingest('{"id":9,"method":"item/fileChange/requestApproval","params":{}}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect((sent[0] as { error: { code: number } }).error.code).toBe(-32603);
    expect(diagnostics).toContainEqual({
      kind: "server-request-handler-failed",
      method: "item/fileChange/requestApproval",
    });
    expect(client.terminated).toBe(false);
  });
});

describe("codex protocol tolerance", () => {
  it("logs and skips an unparseable line, then routes the next message", async () => {
    const { client, diagnostics } = harness();
    const pending = client.request("initialize", {});
    client.ingest('this is not json at all {{{\n{"id":1,"result":{"ok":true}}\n');
    await expect(pending).resolves.toEqual({ ok: true });
    expect(diagnostics).toEqual([{ kind: "unparseable-line", bytes: 27 }]);
    expect(client.terminated).toBe(false);
  });

  it("logs and skips a non-object line", async () => {
    const { client, diagnostics } = harness();
    const pending = client.request("initialize", {});
    client.ingest('[1,2,3]\n"bare"\n{"id":1,"result":{"ok":true}}\n');
    await expect(pending).resolves.toEqual({ ok: true });
    expect(diagnostics).toEqual([
      { kind: "non-object-line", bytes: 7, jsonType: "array" },
      { kind: "non-object-line", bytes: 6, jsonType: "string" },
    ]);
  });

  it("logs and skips a message that is neither request, response nor notification", async () => {
    const { client, diagnostics } = harness();
    client.ingest('{"nothing":"routable","extra":1}\n');
    expect(diagnostics).toEqual([{ kind: "unroutable-message", fields: ["nothing", "extra"] }]);
    expect(client.terminated).toBe(false);
  });

  it("logs and skips a response for an unknown id", async () => {
    const { client, diagnostics } = harness();
    client.ingest('{"id":404,"result":{"stale":true}}\n');
    expect(diagnostics).toEqual([
      { kind: "unknown-response-id", id: "404", fields: ["id", "result"] },
    ]);
  });

  it("never puts a wire payload into a diagnostic", async () => {
    const { client, diagnostics } = harness();
    client.ingest('{"secret":"sk-live-must-not-appear","id":77,"result":{"a":1}}\n');
    client.ingest("not json sk-live-must-not-appear\n");
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("sk-live-must-not-appear");
    expect(diagnostics.length).toBe(2);
  });
});

describe("codex protocol exit semantics", () => {
  it("rejects every pending request and completes the collector on exit", async () => {
    const { client } = harness();
    const first = client.request("account/read", {});
    const second = client.request("config/read", { includeLayers: false });
    const collected = client.notifications.next();
    expect(client.pendingRequestCount).toBe(2);

    client.terminate({ code: 9, signal: null, stderrTail: "ERROR codex crashed" });

    await expect(first).rejects.toBeInstanceOf(CodexProcessExitError);
    await expect(second).rejects.toMatchObject({ name: "CodexProcessExitError", exitCode: 9 });
    await expect(collected).resolves.toEqual({ value: undefined, done: true });
    expect(client.pendingRequestCount).toBe(0);
    expect(client.terminated).toBe(true);
  });

  it("names the signal when the child was killed", async () => {
    const { client } = harness();
    const pending = client.request("turn/start", {});
    client.terminate({ code: null, signal: "SIGKILL" });
    await expect(pending).rejects.toMatchObject({ signal: "SIGKILL" });
    await pending.catch((error: unknown) => {
      expect((error as Error).message).toContain("SIGKILL");
    });
  });

  it("is idempotent on a second exit event", async () => {
    const { client } = harness();
    const pending = client.request("account/read", {});
    client.terminate({ code: 1, signal: null });
    client.terminate({ code: 137, signal: "SIGKILL" });
    await expect(pending).rejects.toMatchObject({ exitCode: 1, signal: null });
  });

  it("rejects a request issued after exit instead of leaving it dangling", async () => {
    const { client } = harness();
    client.terminate({ code: 3, signal: null });
    await expect(client.request("account/read", {})).rejects.toBeInstanceOf(CodexProcessExitError);
    expect(client.pendingRequestCount).toBe(0);
  });

  it("redacts the stderr tail through the injected hook before it reaches the message", async () => {
    const { client } = harness({
      redactStderrTail: (text) => text.replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]"),
    });
    const pending = client.request("account/read", {});
    client.terminate({
      code: 9,
      signal: null,
      stderrTail: "ERROR auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig",
    });
    await pending.catch((error: unknown) => {
      const exit = error as CodexProcessExitError;
      expect(exit.stderrTail).toContain("[redacted]");
      expect(exit.message).toContain("[redacted]");
      expect(exit.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    });
    expect.assertions(3);
  });

  it("ignores stdout that arrives after exit", () => {
    const { client, diagnostics } = harness();
    client.terminate({ code: 0, signal: null });
    client.ingest('{"method":"turn/completed","params":{}}\n');
    expect(diagnostics).toEqual([]);
  });
});

describe("codex protocol against the fake app-server", () => {
  let fake: FakeCodex | null = null;

  afterEach(async () => {
    await fake?.cleanup();
    fake = null;
  });

  interface Spawned {
    client: CodexProtocolClient;
    child: ChildProcessWithoutNullStreams;
    diagnostics: CodexProtocolDiagnostic[];
    stderr: () => string;
    closed: Promise<void>;
  }

  function spawnFake(
    binaryPath: string,
    options: {
      onServerRequest?: (
        request: CodexServerRequest,
      ) => Promise<CodexServerRequestOutcome> | CodexServerRequestOutcome;
      redactStderrTail?: (text: string) => string;
    } = {},
  ): Spawned {
    const child = spawn(process.execPath, [binaryPath, "app-server"], {
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const diagnostics: CodexProtocolDiagnostic[] = [];
    let stderr = "";
    const client = new CodexProtocolClient({
      send: (line) => child.stdin.write(line),
      onServerRequest: options.onServerRequest,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      redactStderrTail: options.redactStderrTail,
    });
    child.stdout.on("data", (chunk: Buffer) => client.ingest(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const closed = new Promise<void>((resolve) => {
      child.on("close", (code, signal) => {
        client.terminate({ code, signal, stderrTail: stderr.trim() });
        resolve();
      });
    });
    return { client, child, diagnostics, stderr: () => stderr, closed };
  }

  it(
    "completes a handshake and records the exact wire shape",
    async () => {
      fake = await createFakeCodex({ script: "handshake-only" });
      const spawned = spawnFake(fake.binaryPath);
      const response = await spawned.client.request<{ userAgent: string }>("initialize", {
        clientInfo: { name: "enduragent", title: "Enduragent", version: "0.0.1" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      expect(response.userAgent).toContain("codex_cli_rs/0.146.0");
      spawned.client.notify("initialized");
      const account = await spawned.client.request<{ account: { type: string } }>(
        "account/read",
        {},
      );
      expect(account.account.type).toBe("chatgpt");

      spawned.child.stdin.end();
      await spawned.closed;

      const frames = await fake.readFramesIn();
      expect(frames.map((frame) => frame.method)).toEqual([
        "initialize",
        "initialized",
        "account/read",
      ]);
      for (const frame of frames) expect(frame).not.toHaveProperty("jsonrpc");
      expect(Object.keys(frames[1] ?? {})).toEqual(["method"]);
      expect(frames[0]?.id).toBe(1);
      expect(frames[2]?.id).toBe(2);
      expect(spawned.diagnostics).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "survives an unsolicited notification arriving at handshake time",
    async () => {
      fake = await createFakeCodex({ script: "handshake-with-unsolicited-status" });
      const spawned = spawnFake(fake.binaryPath);
      const response = await spawned.client.request<{ userAgent: string }>("initialize", {});
      expect(response.userAgent).toContain("codex_cli_rs");
      const notifications = await drain(spawned.client, 3);
      expect(notifications.map((n) => n.method)).toEqual([
        "remoteControl/status/changed",
        "remoteControl/status/changed",
        "configWarning",
      ]);
      expect(spawned.diagnostics).toEqual([]);
      spawned.child.stdin.end();
      await spawned.closed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "survives malformed stdout lines without terminating the session",
    async () => {
      fake = await createFakeCodex({ script: "malformed-line-then-happy" });
      const spawned = spawnFake(fake.binaryPath);
      const response = await spawned.client.request<{ userAgent: string }>("initialize", {});
      expect(response.userAgent).toContain("codex_cli_rs");
      expect(spawned.client.terminated).toBe(false);
      expect(spawned.diagnostics.map((d) => d.kind).sort()).toEqual([
        "non-object-line",
        "unparseable-line",
        "unparseable-line",
        "unroutable-message",
      ]);
      spawned.child.stdin.end();
      await spawned.closed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "ignores an unknown notification method",
    async () => {
      fake = await createFakeCodex({ script: "unknown-notification-then-happy" });
      const spawned = spawnFake(fake.binaryPath);
      const response = await spawned.client.request<{ userAgent: string }>("initialize", {});
      expect(response.userAgent).toContain("codex_cli_rs");
      const notifications = await drain(spawned.client, 2);
      expect(notifications.map((n) => n.method)).toEqual([
        "thread/somethingInventedUpstream",
        "deprecationNotice",
      ]);
      expect(spawned.diagnostics).toEqual([]);
      spawned.child.stdin.end();
      await spawned.closed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "answers an unknown server request with -32601 over the wire",
    async () => {
      fake = await createFakeCodex({ script: "unknown-server-request" });
      const spawned = spawnFake(fake.binaryPath);
      await spawned.client.request("initialize", {});
      for (let waited = 0; waited < 40; waited += 1) {
        const replies = await fake.readReplies();
        if (replies.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const replies = await fake.readReplies();
      expect(replies).toHaveLength(1);
      expect(replies[0]?.error).toEqual({
        code: CODEX_METHOD_NOT_FOUND,
        message: "Method not found: thread/definitelyNotAMethod",
      });
      expect(replies[0]).not.toHaveProperty("jsonrpc");
      spawned.child.stdin.end();
      await spawned.closed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "correlates a response the server echoes with a string id",
    async () => {
      fake = await createFakeCodex({ script: "handshake-string-id-echo" });
      const spawned = spawnFake(fake.binaryPath);
      const response = await spawned.client.request<{ userAgent: string }>("initialize", {});
      expect(response.userAgent).toContain("codex_cli_rs");
      const frames = await fake.readFramesIn();
      expect(frames[0]?.id).toBe(1);
      spawned.child.stdin.end();
      await spawned.closed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects a pending request with the process-exit error when the child dies",
    async () => {
      fake = await createFakeCodex({ script: "die-during-probe-request" });
      const spawned = spawnFake(fake.binaryPath, {
        redactStderrTail: (text) =>
          text.replace(/eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/g, "[redacted]"),
      });
      await spawned.client.request("initialize", {});
      const pending = spawned.client.request("account/read", {});
      await expect(pending).rejects.toBeInstanceOf(CodexProcessExitError);
      await pending.catch((error: unknown) => {
        const exit = error as CodexProcessExitError;
        expect(exit.exitCode).toBe(9);
        expect(exit.message).toContain("exited with code 9");
        expect(exit.message).toContain("[redacted]");
        expect(exit.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      });
      expect(spawned.client.pendingRequestCount).toBe(0);
      await spawned.closed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "replays a different script per spawn for multi-spawn fixtures",
    async () => {
      fake = await createFakeCodex({
        scriptSequence: ["handshake-only", "handshake-string-id-echo"],
      });
      const first = spawnFake(fake.binaryPath);
      await first.client.request("initialize", {});
      first.child.stdin.end();
      await first.closed;

      const second = spawnFake(fake.binaryPath);
      await second.client.request("initialize", {});
      second.child.stdin.end();
      await second.closed;

      expect(await fake.spawnCount()).toBe(2);
      expect(await fake.readFramesIn(0)).toHaveLength(1);
      expect(await fake.readFramesIn(1)).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS,
  );
});
