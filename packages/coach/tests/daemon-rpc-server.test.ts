import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  ServerHandshakeFrameSchema,
  createClientHandshakeFrame,
  parseCoachRpcEnvelope,
  type AthleteState,
  type CoachEngine,
  type CoachOperations,
  type SpendSummary,
} from "@enduragent/coach-contract";
import {
  createCoachRpcServer as createCoachRpcServerProduction,
  ensureDaemonToken,
  type CoachRpcServerInput,
} from "../src/daemon/rpc-server.js";
import { createDaemonHealthState } from "../src/daemon/healthz-server.js";
import type { MonotonicTimer, ScheduledMonotonicTimer } from "../src/daemon/upgrade-fence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const operations: CoachOperations = {
  importFiles: async ({ paths }) => ({
    schemaVersion: 2,
    files: { total: paths.length, imported: paths.length, quarantined: 0 },
    changes: {
      rawFilesInserted: paths.length,
      sourceRecordsInserted: paths.length,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams", status: "available" },
  }),
  sync: async () => ({
    schemaVersion: 1,
    published: true,
    referenceSucceeded: true,
    requests: { store: 1, reference: 1, total: 2 },
  }),
  saveIntake: async () => ({ schemaVersion: 1, saved: true }),
  getTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  listArchivedConversations: async () => ({
    schemaVersion: 1,
    conversations: [],
    truncated: false,
  }),
  getArchivedTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  configureRuntime: async ({ llm, intervals, session }) => ({
    schemaVersion: 3,
    status: "applied",
    applied: {
      llm: llm !== undefined,
      intervals: intervals !== undefined,
      session: session !== undefined,
    },
  }),
  getRuntimeConfig: async () => ({
    schemaVersion: 3,
    llm: {
      provider: "anthropic",
      model: "synthetic-model",
      credential_configured: false,
    },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: false,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  }),
  getUnitsPreference: async () => ({ value: "metric", source: "default" }),
  setUnitsPreference: async ({ value }) => ({ value, source: "cycling" }),
};

const spendSummary: SpendSummary = {
  localDate: "1998-07-06",
  timezone: "UTC",
  dailyCapUsd: 0.5,
  knownSpendUsd: 0,
  generationCount: 0,
  pricedGenerationCount: 0,
  unpricedGenerationCount: 0,
  malformedLineCount: 0,
  spendComplete: true,
  capStatus: "below",
  cacheReadTokens: 0,
  knownCacheReadSavingsUsd: 0,
  cacheSavingsComplete: true,
  routes: [],
};

const spend = {
  getSpendSummary: async () => spendSummary,
  setDailySpendCap: async () => spendSummary,
};

function createCoachRpcServer(
  input: Omit<CoachRpcServerInput, "operations" | "spend" | "selfTestOperations"> &
    Partial<Pick<CoachRpcServerInput, "operations" | "spend" | "selfTestOperations">>,
) {
  return createCoachRpcServerProduction({
    ...input,
    operations: input.operations ?? operations,
    spend: input.spend ?? spend,
    selfTestOperations: input.selfTestOperations ?? {
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    },
  });
}

function engine(overrides: Partial<CoachEngine> = {}): CoachEngine {
  return {
    chat: async () => ({ text: "ok" }),
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
    ...overrides,
  };
}

class CaptureSocket extends Duplex {
  readonly writes: Buffer[] = [];

  _read(): void {}

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

function request(url: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return { url, headers } as IncomingMessage;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeTimer implements MonotonicTimer {
  private now = 0;
  private readonly callbacks = new Set<{
    readonly deadline: number;
    readonly callback: () => void;
    cancelled: boolean;
  }>();

  nowMs(): number {
    return this.now;
  }

  schedule(delayMs: number, callback: () => void): ScheduledMonotonicTimer {
    const scheduled = { deadline: this.now + delayMs, callback, cancelled: false };
    this.callbacks.add(scheduled);
    return {
      cancel: () => {
        scheduled.cancelled = true;
        this.callbacks.delete(scheduled);
      },
    };
  }

  advance(ms: number): void {
    this.now += ms;
    for (const scheduled of this.callbacks) {
      if (!scheduled.cancelled && scheduled.deadline <= this.now) {
        this.callbacks.delete(scheduled);
        scheduled.callback();
      }
    }
  }
}

describe("daemon token", () => {
  it("creates and reuses one exact 0600 base64url token", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-token-"));
    roots.push(root);
    const bytes = Buffer.alloc(32, 7);
    const created = await ensureDaemonToken(root, { randomBytes: () => bytes });
    expect(created.path).toBe(join(root, "daemon.token"));
    expect(created.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await readFile(created.path, "utf8")).toBe(`${created.value}\n`);
    expect((await lstat(created.path)).mode & 0o777).toBe(0o600);
    await expect(ensureDaemonToken(root)).resolves.toEqual(created);
  });

  it("fails closed for symlinks, invalid content, and over-permissive modes", async () => {
    for (const fixture of ["symlink", "invalid", "mode"] as const) {
      const root = await mkdtemp(join(await realpath(tmpdir()), `daemon-token-${fixture}-`));
      roots.push(root);
      const path = join(root, "daemon.token");
      if (fixture === "symlink") {
        const target = join(root, "target");
        await writeFile(target, `${"x".repeat(43)}\n`, { mode: 0o600 });
        await symlink(target, path);
      } else {
        await writeFile(path, fixture === "invalid" ? "not-a-token\n" : `${"x".repeat(43)}\n`, {
          mode: 0o600,
        });
        if (fixture === "mode") await chmod(path, 0o644);
      }
      await expect(ensureDaemonToken(root)).rejects.toThrow("daemon token file is invalid");
      if (fixture === "mode") expect((await lstat(path)).mode & 0o777).toBe(0o644);
    }
  });
});

describe("RPC upgrade refusal", () => {
  it.each([
    [
      "Origin wins over bad path and query",
      "/bad?token=x",
      { origin: "" },
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "bad relative target",
      "http://example.test/rpc",
      {},
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "path wins over query",
      "/bad?token=x",
      {},
      "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
    [
      "empty query is rejected",
      "/rpc?",
      {},
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    ],
  ])("writes exact bytes once: %s", async (_name, url, headers, expected) => {
    const rpc = createCoachRpcServer({
      engine: engine(),
      token: "x".repeat(43),
      owner: "unmanaged-foreground",
    });
    const socket = new CaptureSocket();
    rpc.handleUpgrade(request(url, headers), socket, Buffer.alloc(0));
    await turn();
    expect(Buffer.concat(socket.writes).toString("ascii")).toBe(expected);
    expect(socket.writes).toHaveLength(1);
    expect(socket.destroyed).toBe(true);
    await rpc.close();
  });
});

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM daemon-rpc-server\n");
        resolve(false);
        return;
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
}

const hasLoopback = await loopbackAvailable();

interface FrameQueue {
  next(): Promise<string>;
}

function frameQueue(ws: WebSocket): FrameQueue {
  const frames: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  ws.on("message", (data) => {
    const frame = data.toString();
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  });
  return {
    next() {
      const frame = frames.shift();
      return frame === undefined
        ? new Promise<string>((resolve) => waiters.push(resolve))
        : Promise.resolve(frame);
    },
  };
}

async function openSocket(
  rpc: ReturnType<typeof createCoachRpcServer>,
): Promise<{ readonly ws: WebSocket; readonly frames: FrameQueue; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", rpc.handleUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    frames: frameQueue(ws),
    async close() {
      await rpc.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe.skipIf(!hasLoopback)("authenticated RPC projection", () => {
  it("accepts the first-frame token and projects all four registry methods", async () => {
    const token = "x".repeat(43);
    const calls: string[] = [];
    const rpc = createCoachRpcServer({
      token,
      owner: "unmanaged-foreground",
      engine: engine({
        chat: async (chatRequest, onEvent) => {
          calls.push(`chat:${chatRequest.chatId}`);
          onEvent?.({ type: "turn-start", turnId: "turn-1", chatId: chatRequest.chatId });
          onEvent?.({ type: "final-text", turnId: "turn-1", text: "done" });
          return { text: "done" };
        },
        resetSession: async ({ chatId }) => {
          calls.push(`resetSession:${chatId}`);
          return { memoryFlushed: true };
        },
        hasSession: async ({ chatId }) => {
          calls.push(`hasSession:${chatId}`);
          return { hasSession: true };
        },
        getAthleteState: async () => {
          calls.push("getAthleteState");
          return state;
        },
      }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    expect(ServerHandshakeFrameSchema.parse(JSON.parse(await client.frames.next()))).toEqual({
      type: "handshake",
      status: "accepted",
      clientProtocolVersion: PROTOCOL_VERSION,
      serverProtocolVersion: PROTOCOL_VERSION,
      owner: "unmanaged-foreground",
    });

    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "chat-1",
        method: "chat",
        params: { chatId: "chat", message: "hello" },
      }),
    );
    const firstEvent = parseCoachRpcEnvelope(await client.frames.next());
    const secondEvent = parseCoachRpcEnvelope(await client.frames.next());
    const chatTerminal = parseCoachRpcEnvelope(await client.frames.next());
    expect(firstEvent).toMatchObject({
      method: "coach.turnEvent",
      params: { requestId: "chat-1", requestMethod: "chat", turnId: "turn-1" },
    });
    expect(secondEvent).toMatchObject({
      method: "coach.turnEvent",
      params: { event: { type: "final-text", text: "done" } },
    });
    expect(chatTerminal).toEqual({ jsonrpc: "2.0", id: "chat-1", result: { text: "done" } });

    const requests = [
      { id: 2, method: "resetSession", params: { chatId: "chat" } },
      { id: 3, method: "hasSession", params: { chatId: "chat" } },
      { id: 4, method: "getAthleteState", params: {} },
    ];
    for (const value of requests) {
      client.ws.send(JSON.stringify({ jsonrpc: "2.0", ...value }));
      const response = parseCoachRpcEnvelope(await client.frames.next());
      expect(response).toMatchObject({ jsonrpc: "2.0", id: value.id });
    }
    expect(calls).toEqual(["chat:chat", "resetSession:chat", "hasSession:chat", "getAthleteState"]);
    await client.close();
  });

  it("dispatches authenticated intake and runtime operations without value echo", async () => {
    const token = "x".repeat(43);
    const saveIntake = vi.fn(async () => ({ schemaVersion: 1 as const, saved: true as const }));
    const configureRuntime = vi.fn(async ({ llm, intervals, session }) => ({
      schemaVersion: 3 as const,
      status: "applied" as const,
      applied: {
        llm: llm !== undefined,
        intervals: intervals !== undefined,
        session: session !== undefined,
      },
    }));
    const runtimeSnapshot = {
      schemaVersion: 3 as const,
      llm: {
        provider: "openrouter" as const,
        model: "model-a",
        credential_configured: true,
      },
      intervals: {
        athlete_id: "athlete-a",
        credential_configured: true,
        managedByEnvironment: { athleteId: false },
      },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
        managedByEnvironment: {
          historyTokenBudgetRatio: false,
          idleMinutes: false,
          dailyResetHour: false,
          resetArchiveRetentionDays: false,
          timezone: false,
        },
      },
    };
    const getRuntimeConfig = vi.fn(async () => runtimeSnapshot);
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, saveIntake, configureRuntime, getRuntimeConfig },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const intake = {
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      clinician_cleared: null,
      injury_status: "none",
    } as const;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "intake",
        method: "saveIntake",
        params: intake,
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "intake",
      result: { schemaVersion: 1, saved: true },
    });
    expect(saveIntake).toHaveBeenCalledWith(intake);

    const runtime = {
      llm: { provider: "openrouter", model: "model-a", api_key: "placeholder" },
      intervals: { api_key: "placeholder", athlete_id: "athlete-a" },
    } as const;
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime",
        method: "configureRuntime",
        params: runtime,
      }),
    );
    const response = parseCoachRpcEnvelope(await client.frames.next());
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "runtime",
      result: {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: true, session: false },
      },
    });
    expect(configureRuntime).toHaveBeenCalledWith(runtime);
    expect(JSON.stringify(response)).not.toContain("placeholder");
    expect(JSON.stringify(response)).not.toContain("athlete-a");
    expect(JSON.stringify(response)).not.toContain("model-a");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "runtime-read",
        method: "getRuntimeConfig",
        params: {},
      }),
    );
    const snapshotResponse = parseCoachRpcEnvelope(await client.frames.next());
    expect(snapshotResponse).toEqual({
      jsonrpc: "2.0",
      id: "runtime-read",
      result: runtimeSnapshot,
    });
    expect(getRuntimeConfig).toHaveBeenCalledWith({});
    expect(JSON.stringify(snapshotResponse)).not.toContain("api_key");
    expect(JSON.stringify(snapshotResponse)).not.toContain("token");
    expect(JSON.stringify(snapshotResponse)).not.toContain("path");
    await client.close();
  });

  it("delivers fixed runtime refusals without serializing submitted credentials or account IDs", async () => {
    const token = "x".repeat(43);
    const reasons = [
      "credential-required",
      "ownership-unavailable",
      "training-account-mismatch",
      "managed-by-environment",
    ] as const;
    let call = 0;
    const configureRuntime = vi.fn(async () => ({
      schemaVersion: 3 as const,
      status: "refused" as const,
      reason: reasons[call++]!,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, configureRuntime },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();

    for (const [index, reason] of reasons.entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `refusal-${index}`,
          method: "configureRuntime",
          params: {
            intervals: {
              api_key: `obviously-fake-private-key-${index}`,
              athlete_id: `private-athlete-${index}`,
            },
          },
        }),
      );
      const response = parseCoachRpcEnvelope(await client.frames.next());
      expect(response).toEqual({
        jsonrpc: "2.0",
        id: `refusal-${index}`,
        result: { schemaVersion: 3, status: "refused", reason },
      });
      expect(JSON.stringify(response)).not.toContain("private");
    }

    expect(configureRuntime).toHaveBeenCalledTimes(reasons.length);
    await client.close();
  });

  it("dispatches strict authenticated units reads and writes through the operations object", async () => {
    const token = "x".repeat(43);
    const getUnitsPreference = vi.fn(async () => ({
      value: "metric" as const,
      source: "athlete" as const,
    }));
    const setUnitsPreference = vi.fn(async ({ value }: { value: "metric" | "imperial" }) => ({
      value,
      source: "cycling" as const,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, getUnitsPreference, setUnitsPreference },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "units-read",
        method: "getUnitsPreference",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "units-read",
      result: { value: "metric", source: "athlete" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "units-write",
        method: "setUnitsPreference",
        params: { value: "imperial" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "units-write",
      result: { value: "imperial", source: "cycling" },
    });
    expect(getUnitsPreference).toHaveBeenCalledWith({});
    expect(setUnitsPreference).toHaveBeenCalledWith({ value: "imperial" });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "units-invalid",
        method: "setUnitsPreference",
        params: { value: "other" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "units-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    await client.close();
  });

  it("dispatches bounded transcript reads and refuses malformed hydration requests", async () => {
    const token = "x".repeat(43);
    const getTranscriptPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "page" as const,
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-06T00:00:00.000Z",
          athleteText: "a",
          coachText: "b",
        },
      ],
      nextCursor: null,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, getTranscriptPage },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "transcript-page",
        method: "getTranscriptPage",
        params: { cursor: null, limit: 25 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "transcript-page",
      result: await getTranscriptPage.mock.results[0]!.value,
    });
    expect(getTranscriptPage).toHaveBeenCalledWith({ cursor: null, limit: 25 });

    for (const [index, params] of [
      {},
      { cursor: null, limit: 0 },
      { cursor: null, limit: 51 },
      { cursor: "a".repeat(152), limit: 25 },
      { cursor: null, limit: 25, chatId: "other" },
    ].entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `transcript-invalid-${index}`,
          method: "getTranscriptPage",
          params,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: `transcript-invalid-${index}`,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("dispatches archived conversation reads and refuses malformed archive requests", async () => {
    const token = "x".repeat(43);
    const boundaryRef = "b".repeat(64);
    const listArchivedConversations = vi.fn(async () => ({
      schemaVersion: 1 as const,
      conversations: [
        {
          boundaryRef,
          boundaryAt: "1998-07-06T00:00:00.000Z",
          reason: "explicit-reset" as const,
          turnCount: 2,
        },
      ],
      truncated: false,
    }));
    const getArchivedTranscriptPage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      status: "page" as const,
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-06T00:00:00.000Z",
          athleteText: "a",
          coachText: "b",
        },
      ],
      nextCursor: null,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      operations: { ...operations, listArchivedConversations, getArchivedTranscriptPage },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-list",
        method: "listArchivedConversations",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-list",
      result: await listArchivedConversations.mock.results[0]!.value,
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-page",
        method: "getArchivedTranscriptPage",
        params: { boundaryRef, cursor: null, limit: 25 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-page",
      result: await getArchivedTranscriptPage.mock.results[0]!.value,
    });
    expect(getArchivedTranscriptPage).toHaveBeenCalledWith({
      boundaryRef,
      cursor: null,
      limit: 25,
    });

    for (const [index, params] of [
      {},
      { boundaryRef, cursor: null, limit: 0 },
      { boundaryRef, cursor: null, limit: 51 },
      { boundaryRef: "z".repeat(64), cursor: null, limit: 25 },
      { boundaryRef, cursor: "a".repeat(152), limit: 25 },
      { boundaryRef, cursor: null, limit: 25, chatId: "other" },
    ].entries()) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `archive-invalid-${index}`,
          method: "getArchivedTranscriptPage",
          params,
        }),
      );
      expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
        jsonrpc: "2.0",
        id: `archive-invalid-${index}`,
        error: { code: -32602, message: "Invalid params" },
      });
    }
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "archive-list-invalid",
        method: "listArchivedConversations",
        params: { chatId: "other" },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "archive-list-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(listArchivedConversations).toHaveBeenCalledTimes(1);
    expect(getArchivedTranscriptPage).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("dispatches strict spend reads and cap writes exactly once without notifications", async () => {
    const token = "x".repeat(43);
    const getSpendSummary = vi.fn(async () => spendSummary);
    const setDailySpendCap = vi.fn(async ({ dailyCapUsd }: { dailyCapUsd: number }) => ({
      ...spendSummary,
      dailyCapUsd,
    }));
    const rpc = createCoachRpcServer({
      engine: engine(),
      spend: { getSpendSummary, setDailySpendCap },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "spend-read", method: "getSpendSummary", params: {} }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "spend-read",
      result: spendSummary,
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "spend-write",
        method: "setDailySpendCap",
        params: { dailyCapUsd: 0.75 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "spend-write",
      result: { dailyCapUsd: 0.75 },
    });
    expect(getSpendSummary).toHaveBeenCalledOnce();
    expect(setDailySpendCap).toHaveBeenCalledWith({ dailyCapUsd: 0.75 });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "spend-invalid",
        method: "setDailySpendCap",
        params: { dailyCapUsd: 0 },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "spend-invalid",
      error: { code: -32602, message: "Invalid params" },
    });
    getSpendSummary.mockResolvedValueOnce({
      ...spendSummary,
      knownSpendUsd: 1,
    } as SpendSummary);
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "spend-invalid-result",
        method: "getSpendSummary",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "spend-invalid-result",
      error: { code: -32603, message: "Internal error" },
    });
    await client.close();
  });

  it("dispatches selfTest with request-correlated progress before one terminal", async () => {
    const token = "x".repeat(43);
    const selfTest = vi.fn(async (onEvent?: (event: unknown) => void) => {
      onEvent?.({ phase: "started", completed: 0, total: 1 });
      onEvent?.({ phase: "completed", completed: 1, total: 1 });
      return {
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      } as const;
    });
    const rpc = createCoachRpcServer({
      engine: engine(),
      selfTestOperations: { selfTest },
      token,
      owner: "app-supervised",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({ jsonrpc: "2.0", id: "diagnostic", method: "selfTest", params: {} }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      method: "coach.operationProgress",
      params: {
        requestId: "diagnostic",
        requestMethod: "selfTest",
        event: { phase: "started", completed: 0, total: 1 },
      },
    });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      method: "coach.operationProgress",
      params: {
        requestId: "diagnostic",
        requestMethod: "selfTest",
        event: { phase: "completed", completed: 1, total: 1 },
      },
    });
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "diagnostic",
      result: { ok: false, error: { code: "RUNNER_ERROR" } },
    });
    expect(selfTest).toHaveBeenCalledOnce();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-diagnostic",
        method: "selfTest",
        params: { extra: true },
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject({
      id: "invalid-diagnostic",
      error: { code: -32602, message: "Invalid params" },
    });
    expect(selfTest).toHaveBeenCalledOnce();
    await client.close();
  });

  it("uses authoritative protocol errors, recoverable ids, and method lookup order", async () => {
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "unmanaged-foreground",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const cases = [
      ["{", { id: null, error: { code: -32700, message: "Parse error" } }],
      [JSON.stringify([]), { id: null, error: { code: -32600, message: "Invalid Request" } }],
      [
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "unknown", params: {} }),
        { id: 7, error: { code: -32601, message: "Method not found" } },
      ],
      [
        JSON.stringify({ jsonrpc: "2.0", id: "known", method: "chat", params: {} }),
        { id: "known", error: { code: -32602, message: "Invalid params" } },
      ],
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: "strict-intake",
          method: "saveIntake",
          params: {
            swim_skill_floor: null,
            continuous_distance_capable: null,
            open_water_comfort: null,
            clinician_cleared: null,
            injury_status: "none",
            extra: true,
          },
        }),
        { id: "strict-intake", error: { code: -32602, message: "Invalid params" } },
      ],
      [
        JSON.stringify({ jsonrpc: "1.0", id: "recoverable", method: "chat", params: {} }),
        { id: "recoverable", error: { code: -32600, message: "Invalid Request" } },
      ],
    ] as const;
    for (const [payload, expected] of cases) {
      client.ws.send(payload);
      expect(parseCoachRpcEnvelope(await client.frames.next())).toMatchObject(expected);
    }
    await client.close();
  });

  it("converts a non-JSON registry result into one fixed internal terminal error", async () => {
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      engine: engine({
        getAthleteState: async () => ({
          ...state,
          athleteProfile: 1n,
        }),
      }),
      token,
      owner: "unmanaged-foreground",
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "non-json-result",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(parseCoachRpcEnvelope(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "non-json-result",
      error: {
        code: -32603,
        message: "Internal error",
        data: { name: "Error" },
      },
    });
    await client.close();
  });

  it("returns schema-valid mismatch frames in both directions without dispatch", async () => {
    const token = "x".repeat(43);
    for (const clientProtocolVersion of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
      const chat = vi.fn(async () => ({ text: "unused" }));
      const selfTest = vi.fn();
      const rpc = createCoachRpcServer({
        engine: engine({ chat }),
        selfTestOperations: { selfTest },
        token,
        owner: "unmanaged-foreground",
      });
      const client = await openSocket(rpc);
      client.ws.send(
        JSON.stringify({
          type: "handshake",
          token,
          clientProtocolVersion,
        }),
      );
      const frame = ServerHandshakeFrameSchema.parse(JSON.parse(await client.frames.next()));
      expect(frame).toMatchObject({
        status: "version-mismatch",
        clientProtocolVersion,
        serverProtocolVersion: PROTOCOL_VERSION,
        direction: clientProtocolVersion < PROTOCOL_VERSION ? "client-older" : "client-newer",
      });
      expect(chat).not.toHaveBeenCalled();
      expect(selfTest).not.toHaveBeenCalled();
      await client.close();
    }
  });
});

describe.skipIf(!hasLoopback)("authenticated upgrade control", () => {
  it("binds one reservation to the authenticated connection and consumes it once", async () => {
    const token = "x".repeat(43);
    const healthState = createDaemonHealthState();
    const rpc = createCoachRpcServer({
      engine: engine(),
      token,
      owner: "service-managed",
      healthState,
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    const handoffCapability = Buffer.alloc(32, 3).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "reserve",
      result: { status: "reserved" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "second",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "second",
      error: { code: -32_003, message: "handoff-reservation-refused" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toEqual({
      jsonrpc: "2.0",
      id: "shutdown",
      result: { status: "accepted" },
    });
    await expect(rpc.shutdownRequested).resolves.toBeUndefined();
    expect(healthState.healthy).toBe(false);
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "replay",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "replay",
      error: { code: -32_003, message: "handoff-reservation-refused" },
    });
    await client.close();
  });

  it("drains a running and queued same-key pair before flushing shutdown acceptance", async () => {
    const token = "x".repeat(43);
    const first = deferred<{ text: string }>();
    const second = deferred<{ text: string }>();
    let call = 0;
    const healthState = createDaemonHealthState();
    const rpc = createCoachRpcServer({
      token,
      owner: "ephemeral-client-started",
      healthState,
      engine: engine({
        chat: () => {
          call += 1;
          return call === 1 ? first.promise : second.promise;
        },
      }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    for (const id of ["chat-1", "chat-2"]) {
      client.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "chat",
          params: { chatId: "same", message: id },
        }),
      );
    }
    await vi.waitFor(() => expect(call).toBe(1));
    const handoffCapability = Buffer.alloc(32, 4).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "reserve",
      result: { status: "reserved" },
    });
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await vi.waitFor(() => expect(healthState.healthy).toBe(false));
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "post-close",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "post-close",
      error: { code: -32_005, message: "daemon-upgrading" },
    });
    first.resolve({ text: "first" });
    expect(JSON.parse(await client.frames.next())).toMatchObject({ id: "chat-1" });
    await vi.waitFor(() => expect(call).toBe(2));
    second.resolve({ text: "second" });
    const terminal = [
      JSON.parse(await client.frames.next()),
      JSON.parse(await client.frames.next()),
    ];
    expect(terminal).toContainEqual({
      jsonrpc: "2.0",
      id: "chat-2",
      result: { text: "second" },
    });
    expect(terminal).toContainEqual({
      jsonrpc: "2.0",
      id: "shutdown",
      result: { status: "accepted" },
    });
    await client.close();
  });

  it("restores intake and healthy state after the monotonic drain deadline", async () => {
    const token = "x".repeat(43);
    const work = deferred<{ text: string }>();
    const timer = new FakeTimer();
    const healthState = createDaemonHealthState();
    const chat = vi.fn(() => work.promise);
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      healthState,
      timer,
      engine: engine({ chat }),
    });
    const client = await openSocket(rpc);
    client.ws.send(JSON.stringify(createClientHandshakeFrame(token)));
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "running",
        method: "chat",
        params: { chatId: "same", message: "running" },
      }),
    );
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    const handoffCapability = Buffer.alloc(32, 5).toString("base64url");
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "reserve",
        method: "daemon.reserveUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await client.frames.next();
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "shutdown",
        method: "daemon.shutdownForUpgrade",
        params: { targetProtocolVersion: PROTOCOL_VERSION + 1, handoffCapability },
      }),
    );
    await vi.waitFor(() => expect(healthState.healthy).toBe(false));
    timer.advance(30_000);
    expect(JSON.parse(await client.frames.next())).toMatchObject({
      id: "shutdown",
      error: { code: -32_004, message: "upgrade-drain-timeout" },
    });
    expect(healthState.healthy).toBe(true);
    client.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "read-after-timeout",
        method: "getAthleteState",
        params: {},
      }),
    );
    expect(JSON.parse(await client.frames.next())).toMatchObject({ id: "read-after-timeout" });
    work.resolve({ text: "done" });
    expect(JSON.parse(await client.frames.next())).toMatchObject({ id: "running" });
    await client.close();
  });
});
