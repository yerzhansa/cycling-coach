import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  parseCoachRpcEnvelope,
  serializeCoachRpcEnvelope,
  type CoachTurnEventNotificationEnvelope,
  type JsonRpcProtocolErrorResponseEnvelope,
} from "@enduragent/coach-contract";
import {
  CoachClientBackpressureError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientTransportUnavailableError,
  CoachClientVersionMismatchError,
  CoachRpcRemoteError,
  connectCoachClient,
  resolveCoachWebSocketFactory,
  type CoachClient,
  type CoachClientCallOptions,
  type CoachClientTerminalEnvelope,
} from "../src/index.js";

const token = "synthetic-test-token";

class ControllableSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  sendHook: ((text: string) => void) | undefined;
  closeSynchronously = false;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const text = String(data);
    this.sent.push(text);
    this.sendHook?.(text);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
    if (this.closeSynchronously) this.emitClose(code ?? 1000, reason ?? "");
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  emitError(): void {
    this.dispatchEvent(new Event("error"));
  }

  emitClose(code = 1006, reason = "closed"): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function acceptedSocket(owner = "service-managed" as const): {
  readonly socket: ControllableSocket;
  readonly connecting: Promise<CoachClient>;
} {
  const socket = new ControllableSocket();
  socket.sendHook = (text) => {
    const frame = JSON.parse(text) as { type?: string };
    if (frame.type === "handshake") {
      socket.emitMessage(
        JSON.stringify(createAcceptedServerHandshakeFrame(owner, PROTOCOL_VERSION)),
      );
    }
  };
  const connecting = connectCoachClient({
    url: "ws://127.0.0.1:49152",
    token,
    webSocketFactory: () => socket as unknown as WebSocket,
  });
  socket.emitOpen();
  return { socket, connecting };
}

const servers: WebSocketServer[] = [];
const serverSockets: ServerWebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of serverSockets.splice(0)) socket.terminate();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startServer(
  onConnection: (socket: ServerWebSocket, requestUrl: string | undefined) => void,
): Promise<string> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    serverSockets.push(socket);
    onConnection(socket, request.url);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("missing server address");
  return `ws://127.0.0.1:${address.port}`;
}

describe("connection and transport", () => {
  it("uses the Node global, sends the token frame first, and accepts a verbatim browser factory", async () => {
    const firstFrame = deferred<Record<string, unknown>>();
    const urls: Array<string | undefined> = [];
    const url = await startServer((socket, requestUrl) => {
      urls.push(requestUrl);
      socket.once("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        firstFrame.resolve(frame);
        socket.send(JSON.stringify(createAcceptedServerHandshakeFrame("service-managed", 1)));
      });
    });
    const client = await connectCoachClient({ url, token });
    expect(await firstFrame.promise).toEqual({
      type: "handshake",
      token,
      clientProtocolVersion: 1,
    });
    expect(urls).toEqual(["/"]);
    expect(client.handshake.owner).toBe("service-managed");
    await client.close();

    const socket = new ControllableSocket();
    const factory = vi.fn(() => socket as unknown as WebSocket);
    expect(resolveCoachWebSocketFactory(factory)).toBe(factory);
    socket.sendHook = () =>
      socket.emitMessage(
        JSON.stringify(createAcceptedServerHandshakeFrame("unmanaged-foreground", 1)),
      );
    const browserConnection = connectCoachClient({
      url: "ws://127.0.0.1:49153",
      token,
      webSocketFactory: factory,
    });
    socket.emitOpen();
    const browserClient = await browserConnection;
    expect(factory).toHaveBeenCalledExactlyOnceWith("ws://127.0.0.1:49153");
    socket.closeSynchronously = true;
    await browserClient.close();
  });

  it("maps missing and throwing transports to the stable unavailable error", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: undefined });
    try {
      expect(() => resolveCoachWebSocketFactory()).toThrow(CoachClientTransportUnavailableError);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, "WebSocket", descriptor);
    }
    const error = await connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      webSocketFactory: () => {
        throw new Error("private constructor detail");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoachClientTransportUnavailableError);
    expect(error).toMatchObject({
      name: "CoachClientTransportUnavailableError",
      message: "WebSocket transport is unavailable",
    });
    expect(String(error)).not.toContain("private constructor detail");
  });

  it.each([
    "not a url",
    "http://127.0.0.1:80",
    "https://127.0.0.1:443",
    "wss://127.0.0.1:443",
    "ws://127.0.0.1",
    "ws://127.0.0.1:80",
    "ws://user@127.0.0.1:49152",
    "ws://user:pass@127.0.0.1:49152",
    "ws://127.0.0.1:49152?token=synthetic-test-token",
    "ws://127.0.0.1:49152#fragment",
    "ws://localhost:49152",
    "ws://127.0.0.2:49152",
    "ws://[::1]:49152",
  ])("rejects forbidden URL %s before transport", async (url) => {
    const factory = vi.fn();
    const error = await connectCoachClient({ url, token, webSocketFactory: factory }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoachClientProtocolError);
    expect(error).toMatchObject({
      name: "CoachClientProtocolError",
      message: "Coach client protocol error",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(token);
  });

  it.each([
    { token: "" },
    { connectTimeoutMs: NaN },
    { connectTimeoutMs: Infinity },
    { handshakeTimeoutMs: -1 },
    { closeTimeoutMs: 0 },
    { maxQueuedSends: 1.5 },
    { maxQueuedSends: Number.MAX_SAFE_INTEGER + 1 },
    { highWaterMarkBytes: 0 },
    { highWaterMarkBytes: -Infinity },
    { lowWaterMarkBytes: -1 },
    { lowWaterMarkBytes: NaN },
    { highWaterMarkBytes: 10, lowWaterMarkBytes: 10 },
    { highWaterMarkBytes: 10, lowWaterMarkBytes: 11 },
  ])("rejects invalid options before transport: %o", async (override) => {
    const factory = vi.fn();
    const error = await connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      webSocketFactory: factory,
      ...override,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoachClientProtocolError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("times out an inert connection exactly and cleans up", async () => {
    vi.useFakeTimers();
    const socket = new ControllableSocket();
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      connectTimeoutMs: 37,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    let settled = false;
    void connection.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(36);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await connection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CoachClientHandshakeError",
      message: "Coach client connection timed out",
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("distinguishes pre-aborted and mid-connect aborted signals", async () => {
    const before = new AbortController();
    before.abort();
    const factory = vi.fn();
    await expect(
      connectCoachClient({
        url: "ws://127.0.0.1:49152",
        token,
        signal: before.signal,
        webSocketFactory: factory,
      }),
    ).rejects.toMatchObject({ message: "Coach client connection aborted" });
    expect(factory).not.toHaveBeenCalled();

    const during = new AbortController();
    const socket = new ControllableSocket();
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      signal: during.signal,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    during.abort();
    await expect(connection).rejects.toMatchObject({
      name: "CoachClientHandshakeError",
      message: "Coach client connection aborted",
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toHaveLength(1);
  });
});

describe("handshake failures", () => {
  it.each([
    {
      kind: "timeout",
      expected: CoachClientHandshakeError,
      message: "Coach client handshake timed out",
    },
    {
      kind: "close",
      expected: CoachClientHandshakeError,
      message: "Coach client handshake failed",
    },
    {
      kind: "error",
      expected: CoachClientHandshakeError,
      message: "Coach client handshake failed",
    },
    { kind: "binary", expected: CoachClientProtocolError, message: "Coach client protocol error" },
    {
      kind: "unknown-owner",
      expected: CoachClientProtocolError,
      message: "Coach client protocol error",
    },
    {
      kind: "invalid-accepted",
      expected: CoachClientProtocolError,
      message: "Coach client protocol error",
    },
  ])("fails closed for $kind", async ({ kind, expected, message }) => {
    vi.useFakeTimers();
    const socket = new ControllableSocket();
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      handshakeTimeoutMs: 23,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const outcome = connection.catch((caught: unknown) => caught);
    socket.emitOpen();
    await Promise.resolve();
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(23);
    if (kind === "close") socket.emitClose();
    if (kind === "error") socket.emitError();
    if (kind === "binary") socket.emitMessage(new Uint8Array([1]));
    if (kind === "unknown-owner")
      socket.emitMessage(
        JSON.stringify({
          type: "handshake",
          status: "accepted",
          clientProtocolVersion: 1,
          serverProtocolVersion: 1,
          owner: "app-supervised",
        }),
      );
    if (kind === "invalid-accepted")
      socket.emitMessage(
        JSON.stringify({
          type: "handshake",
          status: "accepted",
          clientProtocolVersion: 1,
          serverProtocolVersion: 2,
          owner: "service-managed",
        }),
      );
    const error = await outcome;
    expect(error).toBeInstanceOf(expected);
    expect(error).toMatchObject({ name: expected.name, message });
    expect(String(error)).not.toContain(token);
  });

  it("maps handshake send throws without retry", async () => {
    const socket = new ControllableSocket();
    socket.sendHook = () => {
      throw new Error("raw send detail");
    };
    const connection = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.emitOpen();
    const error = await connection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CoachClientHandshakeError",
      message: "Coach client handshake send failed",
    });
    expect(socket.sent).toHaveLength(1);
    expect(String(error)).not.toContain(token);
  });

  it.each([
    [1, 2, "client-older", "ephemeral-client-started"],
    [1, 0, "client-newer", "unmanaged-foreground"],
  ] as const)(
    "exposes a trusted mismatch %s/%s",
    async (clientVersion, serverVersion, direction, owner) => {
      const socket = new ControllableSocket();
      socket.sendHook = () =>
        socket.emitMessage(
          JSON.stringify(
            createVersionMismatchServerHandshakeFrame(owner, clientVersion, serverVersion),
          ),
        );
      const connection = connectCoachClient({
        url: "ws://127.0.0.1:49152",
        token,
        webSocketFactory: () => socket as unknown as WebSocket,
      });
      socket.emitOpen();
      const error = await connection.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CoachClientVersionMismatchError);
      expect(error).toMatchObject({
        name: "CoachClientVersionMismatchError",
        message: "Coach protocol version mismatch",
        clientProtocolVersion: clientVersion,
        serverProtocolVersion: serverVersion,
        direction,
        owner,
      });
    },
  );
});

describe("RPC receive and observers", () => {
  it("exercises all methods with monotonic strict requests and parsed results", async () => {
    const received: unknown[] = [];
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = (text) => {
      const request = parseCoachRpcEnvelope(text);
      received.push(request);
      if (!("id" in request) || !("method" in request)) return;
      const results = {
        chat: { text: "answer" },
        resetSession: { memoryFlushed: true },
        hasSession: { hasSession: true },
        getAthleteState: {
          schemaVersion: "1",
          lastUpdated: "2020-01-01T00:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: null,
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        },
      };
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          id: request.id,
          result: results[request.method],
        }),
      );
    };
    await expect(client.call("chat", { chatId: "chat-1", message: "hello" })).resolves.toEqual({
      text: "answer",
    });
    await expect(client.call("resetSession", { chatId: "chat-1" })).resolves.toEqual({
      memoryFlushed: true,
    });
    await expect(client.call("hasSession", { chatId: "chat-1" })).resolves.toEqual({
      hasSession: true,
    });
    await expect(client.call("getAthleteState", {})).resolves.toMatchObject({ schemaVersion: "1" });
    expect(received.map((value) => (value as { id: number }).id)).toEqual([1, 2, 3, 4]);
    expect(received.map((value) => (value as { method: string }).method)).toEqual([
      "chat",
      "resetSession",
      "hasSession",
      "getAthleteState",
    ]);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("rejects non-JSON chat params without sending or consuming an id", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sent.length = 0;
    await expect(
      client.call("chat", {
        chatId: "chat-1",
        message: "hello",
        turn: { resolvedCs: { nested: () => undefined } },
      }),
    ).rejects.toBeInstanceOf(CoachClientProtocolError);
    expect(socket.sent).toEqual([]);
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      socket.emitMessage(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "ok" } }),
      );
    };
    await expect(client.call("chat", { chatId: "chat-1", message: "hello" })).resolves.toEqual({
      text: "ok",
    });
    expect((JSON.parse(socket.sent[0]!) as { id: number }).id).toBe(1);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("routes interleaved notifications in parser-object order and isolates observer throws", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const calls: Array<{ id: number; text: string }> = [];
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      calls.push({ id: request.id, text });
    };
    const observed: string[] = [];
    const envelopes: CoachTurnEventNotificationEnvelope[] = [];
    const first = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      {
        onNotificationEnvelope: (envelope) => {
          envelopes.push(envelope);
          observed.push(`envelope:${envelope.params.event.turnId}`);
          throw new Error("advisory");
        },
        onEvent: (event) => {
          observed.push(`event:${event.turnId}`);
        },
      },
    );
    const second = client.call(
      "chat",
      { chatId: "chat-2", message: "two" },
      {
        onNotificationEnvelope: (envelope) => {
          envelopes.push(envelope);
          observed.push(`envelope:${envelope.params.event.turnId}`);
        },
        onEvent: (event) => {
          observed.push(`event:${event.turnId}`);
          throw new Error("advisory");
        },
      },
    );
    for (const [id, turnId] of [
      [2, "turn-2"],
      [1, "turn-1"],
      [2, "turn-3"],
    ] as const) {
      socket.emitMessage(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          method: "coach.turnEvent",
          params: {
            requestId: id,
            requestMethod: "chat",
            turnId,
            event: { type: "turn-start", turnId, chatId: `chat-${id}` },
          },
        }),
      );
    }
    expect(observed).toEqual([
      "envelope:turn-2",
      "event:turn-2",
      "envelope:turn-1",
      "event:turn-1",
      "envelope:turn-3",
      "event:turn-3",
    ]);
    for (const envelope of envelopes)
      expect(parseCoachRpcEnvelope(serializeCoachRpcEnvelope(envelope))).toEqual(envelope);
    socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "one" } }));
    socket.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { text: "two" } }));
    await expect(first).resolves.toEqual({ text: "one" });
    await expect(second).resolves.toEqual({ text: "two" });
    expect(calls.map((call) => call.id)).toEqual([1, 2]);
    socket.closeSynchronously = true;
    await client.close();
  });

  it("delivers terminal envelopes before settlement and preserves typed remote errors", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const order: string[] = [];
    socket.sendHook = (text) => {
      const request = JSON.parse(text) as { id: number };
      if (request.id === 1)
        socket.emitMessage(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hasSession: false } }),
        );
      else
        socket.emitMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32600, message: "public remote message", data: { safe: true } },
          }),
        );
    };
    const successEnvelopes: CoachClientTerminalEnvelope[] = [];
    const success = client.call(
      "hasSession",
      { chatId: "chat-1" },
      {
        onTerminalEnvelope: (envelope) => {
          successEnvelopes.push(envelope);
          order.push("success-observer");
          throw new Error("advisory");
        },
      },
    );
    await success.then(() => order.push("success-resolve"));
    expect(order).toEqual(["success-observer", "success-resolve"]);
    const failure = client.call(
      "hasSession",
      { chatId: "chat-1" },
      {
        onTerminalEnvelope: (envelope) => {
          successEnvelopes.push(envelope);
          order.push("error-observer");
        },
      },
    );
    const error = await failure.catch((caught: unknown) => {
      order.push("error-catch");
      return caught;
    });
    expect(order.slice(-2)).toEqual(["error-observer", "error-catch"]);
    expect(error).toBeInstanceOf(CoachRpcRemoteError);
    expect(error).toMatchObject({
      name: "CoachRpcRemoteError",
      message: "public remote message",
      code: -32600,
      data: { safe: true },
    });
    expect(successEnvelopes).toHaveLength(2);
    for (const envelope of successEnvelopes)
      expect(parseCoachRpcEnvelope(serializeCoachRpcEnvelope(envelope))).toEqual(envelope);
    socket.closeSynchronously = true;
    await client.close();
  });

  it.each([-32700, -32600] as const)(
    "treats null-id protocol error %s as connection-wide",
    async (code) => {
      const { socket, connecting } = acceptedSocket();
      const client = await connecting;
      socket.sendHook = () => {};
      const terminals = vi.fn();
      const first = client.call(
        "chat",
        { chatId: "chat-1", message: "one" },
        { onTerminalEnvelope: terminals },
      );
      const second = client.call(
        "hasSession",
        { chatId: "chat-2" },
        { onTerminalEnvelope: terminals },
      );
      socket.emitMessage(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message: "protocol" } }),
      );
      const [a, b] = await Promise.all([
        first.catch((error: unknown) => error),
        second.catch((error: unknown) => error),
      ]);
      expect(a).toBeInstanceOf(CoachClientProtocolError);
      expect(b).toBe(a);
      expect(terminals).not.toHaveBeenCalled();
      await expect(client.call("hasSession", { chatId: "chat-1" })).rejects.toBe(a);
      const closing = client.close();
      socket.emitClose(1002, "protocol");
      await closing;
    },
  );

  it.each([
    JSON.stringify({ jsonrpc: "2.0", id: 999, result: { text: "unknown" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32700, message: "bad id" } }),
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "foreign" } }),
    "not-json",
    new Uint8Array([1, 2]),
  ])("fails all pending work for violating frame", async (frame) => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    const terminals = vi.fn();
    const first = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      { onTerminalEnvelope: terminals },
    );
    const second = client.call(
      "hasSession",
      { chatId: "chat-2" },
      { onTerminalEnvelope: terminals },
    );
    socket.emitMessage(frame);
    const [a, b] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);
    expect(a).toBeInstanceOf(CoachClientProtocolError);
    expect(b).toBe(a);
    expect(terminals).not.toHaveBeenCalled();
    const closing = client.close();
    socket.emitClose(1002, "protocol");
    await closing;
  });
});

describe("disconnect, close, and send bounds", () => {
  it("fans an unexpected disconnect to every pending and future call", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    const terminal = vi.fn();
    const a = client.call(
      "chat",
      { chatId: "chat-1", message: "one" },
      { onTerminalEnvelope: terminal },
    );
    const b = client.call("hasSession", { chatId: "chat-2" }, { onTerminalEnvelope: terminal });
    socket.emitClose(1006, "network gone");
    const [first, second] = await Promise.all([
      a.catch((error: unknown) => error),
      b.catch((error: unknown) => error),
    ]);
    expect(first).toBeInstanceOf(CoachClientDisconnectedError);
    expect(first).toMatchObject({
      code: 1006,
      reason: "network gone",
      message: "Coach client disconnected",
    });
    expect(second).toBe(first);
    expect(terminal).not.toHaveBeenCalled();
    await expect(client.call("hasSession", { chatId: "chat-1" })).rejects.toBe(first);
    await client.close();
  });

  it("explicit close is idempotent, settles pending, and handles synchronous close", async () => {
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    socket.sendHook = () => {};
    socket.closeSynchronously = true;
    const pending = client.call("chat", { chatId: "chat-1", message: "one" });
    const first = client.close(1000, "done");
    const second = client.close(1001, "ignored");
    expect(first).toBe(second);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "CoachClientDisconnectedError",
      code: 1000,
      reason: "done",
    });
    await expect(first).resolves.toBeUndefined();
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("resolves explicit close at its bounded timeout when no event arrives", async () => {
    vi.useFakeTimers();
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    const closing = client.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBeUndefined();
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("enforces high-low hysteresis, FIFO order, and 128 waiting sends", async () => {
    vi.useFakeTimers();
    const socket = new ControllableSocket();
    socket.sendHook = (text) => {
      const frame = JSON.parse(text) as { type?: string; id?: number };
      if (frame.type === "handshake")
        socket.emitMessage(
          JSON.stringify(createAcceptedServerHandshakeFrame("service-managed", 1)),
        );
      else if (frame.id !== undefined)
        socket.emitMessage(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { hasSession: true } }),
        );
    };
    const connecting = connectCoachClient({
      url: "ws://127.0.0.1:49152",
      token,
      highWaterMarkBytes: 20,
      lowWaterMarkBytes: 5,
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    socket.emitOpen();
    const client = await connecting;
    socket.sent.length = 0;
    socket.bufferedAmount = 20;
    const admitted = Array.from({ length: 129 }, (_, index) =>
      client.call("hasSession", { chatId: `chat-${index}` }),
    );
    for (const promise of admitted) void promise.catch(() => undefined);
    await expect(client.call("hasSession", { chatId: "overflow" })).rejects.toBeInstanceOf(
      CoachClientBackpressureError,
    );
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 6;
    await vi.advanceTimersByTimeAsync(20);
    expect(socket.sent).toEqual([]);
    socket.bufferedAmount = 5;
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(admitted);
    expect(socket.sent.map((text) => (JSON.parse(text) as { id: number }).id)).toEqual(
      Array.from({ length: 129 }, (_, index) => index + 1),
    );
    socket.closeSynchronously = true;
    await client.close();
  });

  it.each([1, 2])("latches a synchronous RPC send throw at position %s", async (throwAt) => {
    vi.useFakeTimers();
    const { socket, connecting } = acceptedSocket();
    const client = await connecting;
    let sends = 0;
    socket.sendHook = () => {
      sends++;
      if (sends === throwAt) throw new Error("private send detail");
    };
    if (throwAt === 2) socket.bufferedAmount = 1_048_576;
    const first = client.call("hasSession", { chatId: "chat-1" }).catch((error: unknown) => error);
    const second = client.call("hasSession", { chatId: "chat-2" }).catch((error: unknown) => error);
    if (throwAt === 2) {
      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(10);
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeInstanceOf(CoachClientProtocolError);
    expect(b).toBe(a);
    expect(String(a)).not.toContain("private send detail");
    await expect(client.call("hasSession", { chatId: "future" })).rejects.toBe(a);
    const closing = client.close();
    socket.emitClose(1002, "protocol");
    await closing;
  });
});

describe("public observer types", () => {
  it("exports the generic observers and excludes null-id protocol terminals", () => {
    expectTypeOf<CoachClientCallOptions<"chat">["onNotificationEnvelope"]>().toEqualTypeOf<
      ((envelope: CoachTurnEventNotificationEnvelope) => void) | undefined
    >();
    expectTypeOf<CoachClientCallOptions<"chat">["onTerminalEnvelope"]>().toEqualTypeOf<
      ((envelope: CoachClientTerminalEnvelope) => void) | undefined
    >();
    expectTypeOf<JsonRpcProtocolErrorResponseEnvelope>().not.toExtend<CoachClientTerminalEnvelope>();
  });
});
