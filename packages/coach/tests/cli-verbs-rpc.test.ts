import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  CoachClientDisconnectedError,
  connectCoachClient,
  type CoachClient,
} from "@enduragent/coach-client";
import {
  CoachRemoteError,
  connectCoachVerbTransport,
  connectRemoteCoachTransport,
  createCoachVerbRequest,
  runCoachVerb,
  type CoachVerbTransport,
} from "@enduragent/coach-cli";
import {
  EXIT_SUCCESS,
  serializeCoachRpcEnvelope,
  type AthleteState,
  type CoachEngine,
  type CoachOperations,
  type TurnEvent,
} from "@enduragent/coach-contract";
import { createCoachRpcServer, type CoachRpcServer } from "../src/daemon/rpc-server.js";

const token = "s".repeat(43);
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
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: false },
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
};
const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2000-01-01T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2000-01-01T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

function capture(): { readonly stream: Writable; read(): string } {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        callback();
      },
    }),
    read: () => value,
  };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM cli-verbs-rpc\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => server.close(() => resolve(true)));
  });
}

const hasLoopback = await loopbackAvailable();

interface RunningRpc {
  readonly rpc: CoachRpcServer;
  readonly server: Server;
  readonly url: string;
  nextClientDisconnect(): Promise<void>;
}

async function startRpc(engine: CoachEngine): Promise<RunningRpc> {
  const rpc = createCoachRpcServer({
    engine,
    operations,
    spend: {
      getSpendSummary: () => Promise.reject(new Error("Spend handler is not used.")),
      setDailySpendCap: () => Promise.reject(new Error("Spend handler is not used.")),
    },
    selfTestOperations: {
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    },
    token,
    owner: "unmanaged-foreground",
  });
  const server = createServer();
  const disconnectWaiters: Array<() => void> = [];
  server.on("connection", (socket) => {
    socket.once("close", () => disconnectWaiters.shift()?.());
  });
  server.on("upgrade", rpc.handleUpgrade);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("missing test port");
  return {
    rpc,
    server,
    url: `ws://127.0.0.1:${address.port}/rpc`,
    nextClientDisconnect: () => new Promise((resolve) => disconnectWaiters.push(resolve)),
  };
}

async function closeServer(
  running: RunningRpc,
  clients: readonly CoachClient[] = [],
): Promise<void> {
  for (const client of clients) await client.close().catch(() => {});
  await running.rpc.close();
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function closeTransport(transport: CoachVerbTransport | undefined): Promise<void> {
  await transport?.close().catch(() => {});
}

describe.skipIf(!hasLoopback)("CLI verbs over real RPC framing", () => {
  it("runs all five verbs, preserves stream envelopes, and serves warm state under 500 ms", async () => {
    const chatCalls: Parameters<CoachEngine["chat"]>[0][] = [];
    const getAthleteState = vi.fn<CoachEngine["getAthleteState"]>(async () => state);
    const engine: CoachEngine = {
      chat: vi.fn(async (request, onEvent) => {
        chatCalls.push(request);
        const event: TurnEvent = {
          type: "turn-start",
          turnId: `turn-${chatCalls.length}`,
          chatId: request.chatId,
        };
        onEvent?.(event);
        return { text: request.message };
      }),
      getAthleteState,
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
    };
    const running = await startRpc(engine);
    const transports: CoachVerbTransport[] = [];
    try {
      const rows = [
        {
          verb: { name: "ask", input: { kind: "argv", text: "hello" } } as const,
          outputMode: "stream-json" as const,
          expected: "hello",
        },
        {
          verb: { name: "state" } as const,
          outputMode: "json" as const,
          expected: undefined,
        },
        {
          verb: { name: "analyze", target: "last ride" } as const,
          outputMode: "json" as const,
          expected: '/analyze "last ride"',
        },
        {
          verb: { name: "plan-week" } as const,
          outputMode: "text" as const,
          expected: "/plan",
        },
        {
          verb: {
            name: "wellness-set",
            entries: [{ key: "sleep", value: "good" }],
          } as const,
          outputMode: "json" as const,
          expected: '/wellness set [{"key":"sleep","value":"good"}]',
        },
      ];
      let streamOutput = "";
      for (const row of rows) {
        const stdout = capture();
        const stderr = capture();
        const transport = await connectCoachVerbTransport({ url: running.url, token });
        transports.push(transport);
        const request = createCoachVerbRequest({
          verb: row.verb,
          chatId: row.verb.name === "state" ? undefined : "cli:RaceA",
          stdinText: undefined,
          signal: new AbortController().signal,
          callerCwd: "/synthetic/caller",
        });
        await expect(
          runCoachVerb({
            request,
            outputMode: row.outputMode,
            terminal: { stdout: stdout.stream, stderr: stderr.stream },
            transport,
          }),
        ).resolves.toBe(EXIT_SUCCESS);
        expect(stderr.read()).toBe("");
        if (row.outputMode === "stream-json") streamOutput = stdout.read();
        await transport.close();
      }
      expect(chatCalls).toEqual([
        { chatId: "cli:RaceA", message: "hello" },
        { chatId: "cli:RaceA", message: '/analyze "last ride"' },
        { chatId: "cli:RaceA", message: "/plan" },
        {
          chatId: "cli:RaceA",
          message: '/wellness set [{"key":"sleep","value":"good"}]',
        },
      ]);
      expect(getAthleteState).toHaveBeenCalledOnce();
      expect(getAthleteState).toHaveBeenCalledWith();
      const lines = streamOutput
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        jsonrpc: "2.0",
        method: "coach.turnEvent",
        params: { requestMethod: "chat", event: { type: "turn-start" } },
      });
      expect(lines[1]).toMatchObject({ jsonrpc: "2.0", result: { text: "hello" } });
      expect(streamOutput).toBe(lines.map(serializeCoachRpcEnvelope).join("\n") + "\n");

      const warm = await connectCoachVerbTransport({ url: running.url, token });
      transports.push(warm);
      const stdout = capture();
      const stderr = capture();
      const startedAt = performance.now();
      await expect(
        runCoachVerb({
          request: createCoachVerbRequest({
            verb: { name: "state" },
            chatId: undefined,
            stdinText: undefined,
            signal: new AbortController().signal,
            callerCwd: "/synthetic/caller",
          }),
          outputMode: "json",
          terminal: { stdout: stdout.stream, stderr: stderr.stream },
          transport: warm,
        }),
      ).resolves.toBe(EXIT_SUCCESS);
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(stdout.read()).toBe(`${JSON.stringify(state)}\n`);
      expect(stderr.read()).toBe("");
    } finally {
      for (const transport of transports) await closeTransport(transport);
      await closeServer(running);
    }
  });

  it("enforces per-key FIFO, cross-key fairness, queued removal, and in-flight detach", async () => {
    const gates = new Map<string, Deferred<{ text: string }>>();
    const entered: string[] = [];
    const engine: CoachEngine = {
      async chat(request) {
        entered.push(request.message);
        const gate = gates.get(request.message);
        return gate === undefined ? { text: request.message } : gate.promise;
      },
      getAthleteState: async () => state,
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
    };
    const running = await startRpc(engine);
    const clients: CoachClient[] = [];
    const transports: CoachVerbTransport[] = [];
    try {
      const a1Gate = deferred<{ text: string }>();
      gates.set("A1", a1Gate);
      const a1 = await connectCoachClient({ url: running.url, token });
      const a2 = await connectCoachClient({ url: running.url, token });
      const b1 = await connectCoachClient({ url: running.url, token });
      clients.push(a1, a2, b1);
      const a1Call = a1.call("chat", { chatId: "cli:A", message: "A1" });
      await vi.waitFor(() => expect(entered).toEqual(["A1"]));
      const a2Call = a2.call("chat", { chatId: "cli:A", message: "A2" });
      const b1Call = b1.call("chat", { chatId: "cli:B", message: "B1" });
      await expect(b1Call).resolves.toEqual({ text: "B1" });
      expect(entered).toEqual(["A1", "B1"]);
      a1Gate.resolve({ text: "A1" });
      await expect(a1Call).resolves.toEqual({ text: "A1" });
      await expect(a2Call).resolves.toEqual({ text: "A2" });
      expect(entered).toEqual(["A1", "B1", "A2"]);

      const heldGate = deferred<{ text: string }>();
      gates.set("held", heldGate);
      const held = await connectCoachClient({ url: running.url, token });
      const queued = await connectCoachClient({ url: running.url, token });
      clients.push(held, queued);
      const heldCall = held.call("chat", { chatId: "cli:cancel", message: "held" });
      await vi.waitFor(() => expect(entered).toContain("held"));
      const queuedCall = queued.call("chat", { chatId: "cli:cancel", message: "cancelled" });
      const queuedRejection = expect(queuedCall).rejects.toBeInstanceOf(
        CoachClientDisconnectedError,
      );
      const serverObservedDisconnect = running.nextClientDisconnect();
      await queued.close();
      await queuedRejection;
      await serverObservedDisconnect;
      heldGate.resolve({ text: "held" });
      await expect(heldCall).resolves.toEqual({ text: "held" });
      await Promise.resolve();
      expect(entered).not.toContain("cancelled");

      const detachedGate = deferred<{ text: string }>();
      gates.set("detached", detachedGate);
      const detachedTransport = await connectCoachVerbTransport({ url: running.url, token });
      const followerTransport = await connectCoachVerbTransport({ url: running.url, token });
      transports.push(detachedTransport, followerTransport);
      const controller = new AbortController();
      const detachedCall = detachedTransport.request({
        method: "chat",
        params: { chatId: "cli:detach", message: "detached" },
        signal: controller.signal,
        onNotificationEnvelope: () => {},
        onTerminalEnvelope: () => {},
      });
      await vi.waitFor(() => expect(entered).toContain("detached"));
      const followerCall = followerTransport.request({
        method: "chat",
        params: { chatId: "cli:detach", message: "follower" },
        signal: new AbortController().signal,
        onNotificationEnvelope: () => {},
        onTerminalEnvelope: () => {},
      });
      controller.abort();
      await expect(detachedCall).rejects.toMatchObject({ failure: { kind: "detached" } });
      expect(entered).not.toContain("follower");
      detachedGate.resolve({ text: "detached" });
      await expect(followerCall).resolves.toMatchObject({ result: { text: "follower" } });
      expect(entered.indexOf("detached")).toBeLessThan(entered.indexOf("follower"));
    } finally {
      for (const transport of transports) await closeTransport(transport);
      await closeServer(running, clients);
    }
  });

  it("auto-starts once only after absence and reaps the created child on timeout", async () => {
    const winner = {
      kind: "remote",
      request: vi.fn(),
      close: vi.fn(async () => {}),
    } as CoachVerbTransport;
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(winner);
    const detachAfterHealthy = vi.fn();
    const disposeAfterFailedStart = vi.fn(async () => {});
    let now = 0;
    await expect(
      connectRemoteCoachTransport({
        connect,
        serviceRegistrationState: async () => "absent",
        startEphemeralDaemon: async () => ({ detachAfterHealthy, disposeAfterFailedStart }),
        delay: async (ms) => {
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).resolves.toBe(winner);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(detachAfterHealthy).toHaveBeenCalledOnce();
    expect(disposeAfterFailedStart).not.toHaveBeenCalled();

    for (const registration of ["present", "unknown"] as const) {
      const start = vi.fn();
      await expect(
        connectRemoteCoachTransport({
          connect: async () => {
            throw new CoachRemoteError({ kind: "unavailable" });
          },
          serviceRegistrationState: async () => registration,
          startEphemeralDaemon: start,
          delay: async () => {},
          monotonicNow: () => 0,
        }),
      ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
      expect(start).not.toHaveBeenCalled();
    }

    const reap = vi.fn(async () => {});
    now = 0;
    await expect(
      connectRemoteCoachTransport({
        connect: async () => {
          throw new CoachRemoteError({ kind: "unavailable" });
        },
        serviceRegistrationState: async () => "absent",
        startEphemeralDaemon: async () => ({
          detachAfterHealthy: vi.fn(),
          disposeAfterFailedStart: reap,
        }),
        delay: async (ms) => {
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
    expect(reap).toHaveBeenCalledOnce();
  });
});
