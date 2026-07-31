import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CoachTurnEventNotificationEnvelopeSchema,
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_VERSION_MISMATCH,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  serializeCoachRpcEnvelope,
  type AthleteState,
  type CoachEngine,
  type CoachTurnEventNotificationEnvelope,
  type JsonRpcErrorResponseEnvelope,
  type JsonRpcSuccessResponseEnvelope,
} from "@enduragent/coach-contract";
import {
  CoachRemoteError,
  connectRemoteCoachTransport,
  createCoachVerbRequest,
  createLocalCoachVerbTransport,
  runCoachVerb,
  type CoachVerbRequest,
  type CoachVerbTransport,
} from "../src/index.js";

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

function terminal() {
  const stdout = capture();
  const stderr = capture();
  return { stdout, stderr, value: { stdout: stdout.stream, stderr: stderr.stream } };
}

function success(result: unknown): JsonRpcSuccessResponseEnvelope {
  return JsonRpcSuccessResponseEnvelopeSchema.parse({ jsonrpc: "2.0", id: 1, result });
}

function failure(): JsonRpcErrorResponseEnvelope {
  return JsonRpcErrorResponseEnvelopeSchema.parse({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error" },
  });
}

function notification(): CoachTurnEventNotificationEnvelope {
  return CoachTurnEventNotificationEnvelopeSchema.parse({
    jsonrpc: "2.0",
    method: "coach.turnEvent",
    params: {
      requestId: 1,
      requestMethod: "chat",
      turnId: "turn-1",
      event: { type: "turn-start", turnId: "turn-1", chatId: "cli:default" },
    },
  });
}

function request(
  method: "chat" | "getAthleteState" = "chat",
  signal = new AbortController().signal,
): CoachVerbRequest {
  return method === "chat"
    ? {
        method,
        params: { chatId: "cli:default", message: "hello" },
        signal,
        onNotificationEnvelope: () => {},
        onTerminalEnvelope: () => {},
      }
    : {
        method,
        params: {},
        signal,
        onNotificationEnvelope: () => {},
        onTerminalEnvelope: () => {},
      };
}

function deliveringTransport(input: {
  readonly terminal: JsonRpcSuccessResponseEnvelope | JsonRpcErrorResponseEnvelope;
  readonly notifications?: readonly CoachTurnEventNotificationEnvelope[];
}): CoachVerbTransport {
  return {
    kind: "remote",
    async request(command) {
      for (const envelope of input.notifications ?? []) {
        if (command.method !== "chat") throw new TypeError("unexpected chat notification");
        command.onNotificationEnvelope(envelope);
      }
      command.onTerminalEnvelope(input.terminal);
      return input.terminal;
    },
    async close() {},
  };
}

describe("verb dispatch", () => {
  it("constructs the exhaustive method and message table", () => {
    const signal = new AbortController().signal;
    const rows = [
      {
        verb: { name: "ask", input: { kind: "argv", text: "unchanged" } } as const,
        stdinText: undefined,
        method: "chat",
        params: { chatId: "cli:RaceA", message: "unchanged" },
      },
      {
        verb: { name: "ask", input: { kind: "stdin" } } as const,
        stdinText: "stdin text",
        method: "chat",
        params: { chatId: "cli:RaceA", message: "stdin text" },
      },
      {
        verb: { name: "analyze", target: "last ride" } as const,
        stdinText: undefined,
        method: "chat",
        params: { chatId: "cli:RaceA", message: '/analyze "last ride"' },
      },
      {
        verb: { name: "plan-week" } as const,
        stdinText: undefined,
        method: "chat",
        params: { chatId: "cli:RaceA", message: "/plan" },
      },
      {
        verb: {
          name: "wellness-set",
          entries: [
            { key: "note", value: "a=b" },
            { key: "sleep", value: "good" },
          ],
        } as const,
        stdinText: undefined,
        method: "chat",
        params: {
          chatId: "cli:RaceA",
          message: '/wellness set [{"key":"note","value":"a=b"},{"key":"sleep","value":"good"}]',
        },
      },
    ];
    for (const row of rows) {
      const created = createCoachVerbRequest({
        verb: row.verb,
        chatId: "cli:RaceA",
        stdinText: row.stdinText,
        signal,
        callerCwd: "/synthetic/caller",
      });
      expect(created).toMatchObject({ method: row.method, params: row.params, signal });
      expect(created.params as Record<string, unknown>).not.toHaveProperty("turn");
    }
    expect(
      createCoachVerbRequest({
        verb: { name: "state" },
        chatId: undefined,
        stdinText: undefined,
        signal,
        callerCwd: "/synthetic/caller",
      }),
    ).toMatchObject({ method: "getAthleteState", params: {}, signal });
    expect(
      createCoachVerbRequest({
        verb: { name: "import", paths: ["ride.fit", "--dash.tcx"] },
        chatId: undefined,
        stdinText: undefined,
        signal,
        callerCwd: "/synthetic/caller",
      }),
    ).toMatchObject({
      method: "importFiles",
      params: { paths: ["/synthetic/caller/ride.fit", "/synthetic/caller/--dash.tcx"] },
    });
    expect(
      createCoachVerbRequest({
        verb: { name: "sync" },
        chatId: undefined,
        stdinText: undefined,
        signal,
        callerCwd: "/synthetic/caller",
      }),
    ).toMatchObject({ method: "sync", params: {} });
    expect(() =>
      createCoachVerbRequest({
        verb: { name: "import", paths: ["a/../ride.fit", "ride.fit"] },
        chatId: undefined,
        stdinText: undefined,
        signal,
        callerCwd: "/synthetic/caller",
      }),
    ).toThrow();
  });
});

describe("verb rendering", () => {
  it("renders chat and state text exactly", async () => {
    const chatIo = terminal();
    await expect(
      runCoachVerb({
        request: request("chat"),
        outputMode: "text",
        terminal: chatIo.value,
        transport: deliveringTransport({ terminal: success({ text: "answer" }) }),
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(chatIo.stdout.read()).toBe("answer\n");
    expect(chatIo.stderr.read()).toBe("");

    const stateIo = terminal();
    await expect(
      runCoachVerb({
        request: request("getAthleteState"),
        outputMode: "text",
        terminal: stateIo.value,
        transport: deliveringTransport({ terminal: success(state) }),
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(stateIo.stdout.read()).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect(stateIo.stderr.read()).toBe("");
  });

  it("renders one unwrapped JSON result and discards notifications", async () => {
    const io = terminal();
    await expect(
      runCoachVerb({
        request: request(),
        outputMode: "json",
        terminal: io.value,
        transport: deliveringTransport({
          terminal: success({ text: "answer" }),
          notifications: [notification()],
        }),
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe('{"text":"answer"}\n');
    expect(io.stderr.read()).toBe("");
  });

  it("renders operational text and JSON results exactly", async () => {
    const signal = new AbortController().signal;
    const importRequest = createCoachVerbRequest({
      verb: { name: "import", paths: ["ride.fit"] },
      chatId: undefined,
      stdinText: undefined,
      signal,
      callerCwd: "/synthetic/caller",
    });
    for (const [status, expected] of [
      [
        "available",
        "Local library import: 1 of 1 files imported (0 quarantined). Coaching access to activities and streams is available.\n",
      ],
      [
        "retryable-failure",
        "Local library import: 1 of 1 files imported (0 quarantined). Coaching access to activities and streams is temporarily unavailable; retry the import.\n",
      ],
    ] as const) {
      const importIo = terminal();
      await expect(
        runCoachVerb({
          request: importRequest,
          outputMode: "text",
          terminal: importIo.value,
          transport: deliveringTransport({
            terminal: success({
              schemaVersion: 2,
              files: { total: 1, imported: 1, quarantined: 0 },
              changes: {
                rawFilesInserted: 1,
                sourceRecordsInserted: 1,
                sourceRecordsUpdated: 0,
                relinkedSourceRecords: 0,
              },
              publication: { scope: "activities-and-streams", status },
            }),
          }),
        }),
      ).resolves.toBe(EXIT_SUCCESS);
      expect(importIo.stdout.read()).toBe(expected);
      expect(importIo.stdout.read()).not.toMatch(/\b(?:updated|published|internal)\b/iu);
    }
    for (const [published, expected] of [
      [true, "Training data refreshed.\n"],
      [false, "Training data checked; no new snapshot was published.\n"],
    ] as const) {
      const syncIo = terminal();
      const syncRequest = createCoachVerbRequest({
        verb: { name: "sync" },
        chatId: undefined,
        stdinText: undefined,
        signal,
        callerCwd: "/synthetic/caller",
      });
      await expect(
        runCoachVerb({
          request: syncRequest,
          outputMode: "text",
          terminal: syncIo.value,
          transport: deliveringTransport({
            terminal: success({
              schemaVersion: 1,
              published,
              referenceSucceeded: true,
              requests: { store: 0, reference: 0, total: 0 },
            }),
          }),
        }),
      ).resolves.toBe(EXIT_SUCCESS);
      expect(syncIo.stdout.read()).toBe(expected);
    }
  });

  it("renders notification and terminal envelopes verbatim in order", async () => {
    const io = terminal();
    const event = notification();
    const terminalEnvelope = success({ text: "answer" });
    await expect(
      runCoachVerb({
        request: request(),
        outputMode: "stream-json",
        terminal: io.value,
        transport: deliveringTransport({ terminal: terminalEnvelope, notifications: [event] }),
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe(
      `${serializeCoachRpcEnvelope(event)}\n${serializeCoachRpcEnvelope(terminalEnvelope)}\n`,
    );
    expect(io.stderr.read()).toBe("");
  });

  it("keeps terminal errors on stream stdout only", async () => {
    for (const outputMode of ["text", "json", "stream-json"] as const) {
      const io = terminal();
      const errorEnvelope = failure();
      await expect(
        runCoachVerb({
          request: request(),
          outputMode,
          terminal: io.value,
          transport: deliveringTransport({ terminal: errorEnvelope }),
        }),
      ).resolves.toBe(EXIT_AGENT_ERROR);
      expect(io.stdout.read()).toBe(
        outputMode === "stream-json" ? `${serializeCoachRpcEnvelope(errorEnvelope)}\n` : "",
      );
      expect(io.stderr.read()).toBe("Enduragent could not complete this command.\n");
    }
  });

  it("maps every typed remote failure without stdout diagnostics", async () => {
    const rows = [
      {
        failure: { kind: "agent" } as const,
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent could not complete this command.\n",
      },
      {
        failure: { kind: "detached" } as const,
        exitCode: EXIT_AGENT_ERROR,
        stderr: "Enduragent detached from the running turn; the turn may still complete.\n",
      },
      {
        failure: { kind: "unavailable" } as const,
        exitCode: EXIT_DAEMON_UNAVAILABLE,
        stderr: "Enduragent could not reach the local service.\n",
      },
      {
        failure: { kind: "version-mismatch", direction: "client-newer" } as const,
        exitCode: EXIT_VERSION_MISMATCH,
        stderr: "Enduragent protocol versions do not match; update this client.\n",
      },
    ];
    for (const row of rows) {
      const io = terminal();
      await expect(
        runCoachVerb({
          request: request(),
          outputMode: "json",
          terminal: io.value,
          transport: {
            kind: "remote",
            request: async () => {
              throw new CoachRemoteError(row.failure);
            },
            async close() {},
          },
        }),
      ).resolves.toBe(row.exitCode);
      expect(io.stdout.read()).toBe("");
      expect(io.stderr.read()).toBe(row.stderr);
    }
  });
});

describe("local projection and auto-start", () => {
  it("calls only the selected engine method and emits exact local envelopes", async () => {
    const chat = vi.fn<CoachEngine["chat"]>(async (params, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "turn-1", chatId: params.chatId });
      return { text: params.message };
    });
    const getAthleteState = vi.fn<CoachEngine["getAthleteState"]>(async () => state);
    const engine: CoachEngine = {
      chat,
      getAthleteState,
      resetSession: vi.fn(async () => ({ memoryFlushed: true })),
      hasSession: vi.fn(async () => ({ hasSession: false })),
    };
    const chatIo = terminal();
    await expect(
      runCoachVerb({
        request: request("chat"),
        outputMode: "stream-json",
        terminal: chatIo.value,
        transport: createLocalCoachVerbTransport(engine),
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(chat).toHaveBeenCalledWith(
      { chatId: "cli:default", message: "hello" },
      expect.any(Function),
    );
    expect(chatIo.stdout.read().split("\n").filter(Boolean)).toHaveLength(2);

    const stateIo = terminal();
    await expect(
      runCoachVerb({
        request: request("getAthleteState"),
        outputMode: "json",
        terminal: stateIo.value,
        transport: createLocalCoachVerbTransport(engine),
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(getAthleteState).toHaveBeenCalledWith();
    expect(stateIo.stdout.read()).toBe(`${JSON.stringify(state)}\n`);
  });

  it("detaches local delivery without cancelling an in-flight engine turn", async () => {
    let resolveTurn!: (value: { text: string }) => void;
    const turn = new Promise<{ text: string }>((resolve) => {
      resolveTurn = resolve;
    });
    const engine: CoachEngine = {
      chat: vi.fn(async () => turn),
      getAthleteState: async () => state,
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
    };
    const controller = new AbortController();
    const io = terminal();
    const result = runCoachVerb({
      request: request("chat", controller.signal),
      outputMode: "text",
      terminal: io.value,
      transport: createLocalCoachVerbTransport(engine),
    });
    await vi.waitFor(() => expect(engine.chat).toHaveBeenCalledTimes(1));
    controller.abort();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveTurn({ text: "late" });
    await expect(result).resolves.toBe(EXIT_AGENT_ERROR);
    expect(io.stdout.read()).toBe("");
    expect(io.stderr.read()).toBe(
      "Enduragent detached from the running turn; the turn may still complete.\n",
    );
  });

  it("spawns once only after confirmed registration absence and attaches to the winner", async () => {
    const winner = deliveringTransport({ terminal: success({ text: "ok" }) });
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(winner);
    const detachAfterHealthy = vi.fn();
    const disposeAfterFailedStart = vi.fn(async () => {});
    const startEphemeralDaemon = vi.fn(async () => ({
      detachAfterHealthy,
      disposeAfterFailedStart,
    }));
    let now = 0;
    await expect(
      connectRemoteCoachTransport({
        connect,
        serviceRegistrationState: vi.fn(async (): Promise<"absent"> => "absent"),
        startEphemeralDaemon,
        delay: async (ms) => {
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).resolves.toBe(winner);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(startEphemeralDaemon).toHaveBeenCalledTimes(1);
    expect(detachAfterHealthy).toHaveBeenCalledTimes(1);
    expect(disposeAfterFailedStart).not.toHaveBeenCalled();
  });

  it("fails closed for present and unknown registrations", async () => {
    for (const registration of ["present", "unknown"] as const) {
      const startEphemeralDaemon = vi.fn();
      await expect(
        connectRemoteCoachTransport({
          connect: async () => {
            throw new CoachRemoteError({ kind: "unavailable" });
          },
          serviceRegistrationState: async () => registration,
          startEphemeralDaemon,
          delay: async () => {},
          monotonicNow: () => 0,
        }),
      ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
      expect(startEphemeralDaemon).not.toHaveBeenCalled();
    }
  });

  it("times out at the exact budget and reaps only its child", async () => {
    const disposeAfterFailedStart = vi.fn(async () => {});
    let now = 0;
    const delays: number[] = [];
    await expect(
      connectRemoteCoachTransport({
        connect: async () => {
          throw new CoachRemoteError({ kind: "unavailable" });
        },
        serviceRegistrationState: async () => "absent",
        startEphemeralDaemon: async () => ({
          detachAfterHealthy: vi.fn(),
          disposeAfterFailedStart,
        }),
        delay: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
    expect(delays.slice(0, 3)).toEqual([50, 100, 200]);
    expect(delays.reduce((sum, value) => sum + value, 0)).toBe(5_000);
    expect(disposeAfterFailedStart).toHaveBeenCalledTimes(1);
  });
});
