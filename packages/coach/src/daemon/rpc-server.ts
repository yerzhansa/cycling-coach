import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  ClientHandshakeFrameSchema,
  COACH_RPC_METHOD_REGISTRY,
  CoachRpcRequestEnvelopeSchema,
  CoachTurnEventNotificationEnvelopeSchema,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcIdSchema,
  JsonRpcProtocolErrorResponseEnvelopeSchema,
  JsonRpcRequestEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  PROTOCOL_VERSION,
  compareProtocolVersions,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  serializeCoachRpcEnvelope,
  type CoachEngine,
  type CoachRpcMethodName,
  type DaemonOwner,
  type JsonRpcId,
} from "@enduragent/coach-contract";
import type { WriterProtocolHandlers } from "@enduragent/kernel-node/lock";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const AUTH_TIMEOUT_MS = 1_000;
const MAX_PAYLOAD_BYTES = 1_048_576;
const AUTH_FAILURE_REASON = "authentication failed";
const FORBIDDEN_RESPONSE =
  "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_REQUEST_RESPONSE =
  "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const NOT_FOUND_RESPONSE =
  "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const UNAVAILABLE_RESPONSE =
  "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

export interface DaemonToken {
  readonly path: string;
  readonly value: string;
}

export interface DaemonTokenDependencies {
  readonly randomBytes?: typeof randomBytes;
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function readExistingToken(path: string): Promise<DaemonToken> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("daemon token file is invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      (openedMetadata.mode & 0o777) !== 0o600 ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error("daemon token file is invalid");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : "";
  if (!validToken(value) || raw !== `${value}\n`) {
    throw new Error("daemon token file is invalid");
  }
  return { path, value };
}

export async function ensureDaemonToken(
  configDir: string,
  dependencies: DaemonTokenDependencies = {},
): Promise<DaemonToken> {
  const path = join(configDir, "daemon.token");
  try {
    return await readExistingToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = (dependencies.randomBytes ?? randomBytes)(32).toString("base64url");
  if (!validToken(value)) throw new Error("daemon token generation failed");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readExistingToken(path);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return { path, value };
}

export interface CoachRpcServerInput {
  readonly engine: CoachEngine;
  readonly token: string;
  readonly owner: DaemonOwner;
}

export interface CoachRpcServer {
  readonly handleUpgrade: WriterProtocolHandlers["upgrade"];
  close(): Promise<void>;
}

interface ClientState {
  readonly ws: WebSocket;
  readonly activeIds: Set<string>;
  readonly requestTasks: Set<Promise<void>>;
  readonly pendingSendResolvers: Set<() => void>;
  readonly detachedPromise: Promise<void>;
  readonly resolveDetached: () => void;
  readonly closedPromise: Promise<void>;
  readonly resolveClosed: () => void;
  sendTail: Promise<void>;
  authTimer: ReturnType<typeof setTimeout> | undefined;
  authenticated: boolean;
  detached: boolean;
  closed: boolean;
}

function createClientState(ws: WebSocket): ClientState {
  let resolveDetached!: () => void;
  let resolveClosed!: () => void;
  const detachedPromise = new Promise<void>((resolve) => {
    resolveDetached = resolve;
  });
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    ws,
    activeIds: new Set(),
    requestTasks: new Set(),
    pendingSendResolvers: new Set(),
    detachedPromise,
    resolveDetached,
    closedPromise,
    resolveClosed,
    sendTail: Promise.resolve(),
    authTimer: undefined,
    authenticated: false,
    detached: false,
    closed: false,
  };
}

function clearAuthTimer(state: ClientState): void {
  if (state.authTimer === undefined) return;
  clearTimeout(state.authTimer);
  state.authTimer = undefined;
}

function detach(state: ClientState, closeCode?: number, reason?: string): void {
  if (!state.detached) {
    state.detached = true;
    state.resolveDetached();
    for (const resolve of state.pendingSendResolvers) resolve();
    state.pendingSendResolvers.clear();
  }
  if (closeCode !== undefined && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.close(closeCode, reason);
    } catch {
      state.ws.terminate();
    }
  }
}

function enqueueSerialized(state: ClientState, serialized: string): Promise<void> {
  const step = state.sendTail.then(async () => {
    if (state.detached) return;
    if (state.ws.bufferedAmount + Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
      detach(state, 1013, "backpressure");
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        state.pendingSendResolvers.delete(finish);
        resolve();
      };
      state.pendingSendResolvers.add(finish);
      void state.detachedPromise.then(finish);
      try {
        state.ws.send(serialized, (error) => {
          if (error !== undefined) detach(state, 1013, "backpressure");
          finish();
        });
      } catch {
        detach(state, 1013, "backpressure");
        finish();
      }
    });
  });
  state.sendTail = step.catch(() => {});
  return state.sendTail;
}

function protocolError(code: -32700 | -32600, message: string): string {
  return serializeCoachRpcEnvelope(
    JsonRpcProtocolErrorResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id: null,
      error: { code, message },
    }),
  );
}

function ordinaryError(id: JsonRpcId, code: number, message: string): string {
  return serializeCoachRpcEnvelope(
    JsonRpcErrorResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }),
  );
}

function recoveredId(value: unknown): JsonRpcId | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, "id")) return undefined;
  const parsed = JsonRpcIdSchema.safeParse((value as { readonly id?: unknown }).id);
  return parsed.success ? parsed.data : undefined;
}

function methodExists(method: string): method is CoachRpcMethodName {
  return Object.prototype.hasOwnProperty.call(COACH_RPC_METHOD_REGISTRY, method);
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sameToken(received: string, expected: string): boolean {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function refuseUpgrade(
  socket: Parameters<WriterProtocolHandlers["upgrade"]>[1],
  response: string,
): void {
  socket.once("error", () => socket.destroy());
  socket.write(response, "ascii", () => socket.destroy());
}

export function createCoachRpcServer(input: CoachRpcServerInput): CoachRpcServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const clients = new Set<ClientState>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const handleRequest = (state: ClientState, data: RawData, isBinary: boolean): void => {
    if (closing) {
      detach(state, 1001);
      return;
    }
    if (isBinary) {
      void enqueueSerialized(state, protocolError(-32600, "Invalid Request"));
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText(data));
    } catch {
      void enqueueSerialized(state, protocolError(-32700, "Parse error"));
      return;
    }
    const generic = JsonRpcRequestEnvelopeSchema.safeParse(parsedJson);
    if (!generic.success) {
      const id = recoveredId(parsedJson);
      void enqueueSerialized(
        state,
        id === undefined
          ? protocolError(-32600, "Invalid Request")
          : ordinaryError(id, -32600, "Invalid Request"),
      );
      return;
    }
    if (!methodExists(generic.data.method)) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32601, "Method not found"));
      return;
    }
    const registry = COACH_RPC_METHOD_REGISTRY[generic.data.method];
    const specialized = CoachRpcRequestEnvelopeSchema.safeParse(generic.data);
    const params = registry.requestSchema.safeParse(generic.data.params);
    if (!specialized.success || !params.success) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
      return;
    }
    const key = idKey(generic.data.id);
    if (state.activeIds.has(key)) {
      detach(state, 1008);
      return;
    }
    state.activeIds.add(key);
    const task = (async () => {
      let invocationFailed = false;
      let eventFailed = false;
      let result: unknown;
      try {
        switch (registry.wireName) {
          case "chat":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.chat.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.chat(request, (event) => {
                if (eventFailed) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY.chat.eventSchema.parse(event);
                  const notification = CoachTurnEventNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.turnEvent",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "chat",
                      turnId: parsedEvent.turnId,
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch {
                  eventFailed = true;
                }
              });
            } catch {
              invocationFailed = true;
            }
            break;
          case "resetSession":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.resetSession.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.resetSession(request);
            } catch {
              invocationFailed = true;
            }
            break;
          case "hasSession":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.hasSession.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.hasSession(request);
            } catch {
              invocationFailed = true;
            }
            break;
          case "getAthleteState":
            try {
              COACH_RPC_METHOD_REGISTRY.getAthleteState.requestSchema.parse(generic.data.params);
              result = await input.engine.getAthleteState();
            } catch {
              invocationFailed = true;
            }
            break;
        }
        let terminal: string;
        if (invocationFailed || eventFailed) {
          terminal = ordinaryError(generic.data.id, -32603, "Internal error");
        } else {
          const response = registry.responseSchema.safeParse(result);
          if (!response.success) {
            terminal = ordinaryError(generic.data.id, -32603, "Internal error");
          } else {
            try {
              terminal = serializeCoachRpcEnvelope(
                JsonRpcSuccessResponseEnvelopeSchema.parse({
                  jsonrpc: "2.0",
                  id: generic.data.id,
                  result: response.data,
                }),
              );
            } catch {
              terminal = ordinaryError(generic.data.id, -32603, "Internal error");
            }
          }
        }
        await enqueueSerialized(state, terminal);
      } finally {
        state.activeIds.delete(key);
      }
    })();
    state.requestTasks.add(task);
    void task.finally(() => state.requestTasks.delete(task)).catch(() => {});
  };

  const acceptClient = (ws: WebSocket): void => {
    const state = createClientState(ws);
    clients.add(state);
    ws.on("close", () => {
      clearAuthTimer(state);
      detach(state);
      state.closed = true;
      state.resolveClosed();
      void Promise.all(state.requestTasks)
        .catch(() => {})
        .then(() => state.sendTail)
        .finally(() => clients.delete(state));
    });
    ws.on("error", () => {
      clearAuthTimer(state);
      detach(state);
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    });
    state.authTimer = setTimeout(() => {
      state.authTimer = undefined;
      detach(state, 1008, AUTH_FAILURE_REASON);
    }, AUTH_TIMEOUT_MS);
    state.authTimer.unref?.();
    ws.once("message", (data, isBinary) => {
      clearAuthTimer(state);
      if (isBinary) {
        detach(state, 1008, AUTH_FAILURE_REASON);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(rawText(data));
      } catch {
        detach(state, 1008, AUTH_FAILURE_REASON);
        return;
      }
      const handshake = ClientHandshakeFrameSchema.safeParse(value);
      if (!handshake.success || !sameToken(handshake.data.token, input.token)) {
        detach(state, 1008, AUTH_FAILURE_REASON);
        return;
      }
      const comparison = compareProtocolVersions(
        handshake.data.clientProtocolVersion,
        PROTOCOL_VERSION,
      );
      if (comparison !== "equal") {
        const frame = createVersionMismatchServerHandshakeFrame(
          input.owner,
          handshake.data.clientProtocolVersion,
        );
        void enqueueSerialized(state, JSON.stringify(frame)).then(() => {
          clearAuthTimer(state);
          detach(state, 1002);
        });
        return;
      }
      state.authenticated = true;
      const frame = createAcceptedServerHandshakeFrame(
        input.owner,
        handshake.data.clientProtocolVersion,
      );
      void enqueueSerialized(state, JSON.stringify(frame));
      ws.on("message", (requestData, requestIsBinary) => {
        handleRequest(state, requestData, requestIsBinary);
      });
    });
  };

  const handleUpgrade: WriterProtocolHandlers["upgrade"] = (request, socket, head) => {
    if (Object.prototype.hasOwnProperty.call(request.headers, "origin")) {
      refuseUpgrade(socket, FORBIDDEN_RESPONSE);
      return;
    }
    const rawTarget = request.url ?? "";
    let target: URL;
    try {
      target = new URL(rawTarget, "http://127.0.0.1");
      if (!rawTarget.startsWith("/") || target.origin !== "http://127.0.0.1") {
        throw new TypeError("invalid relative URL");
      }
    } catch {
      refuseUpgrade(socket, BAD_REQUEST_RESPONSE);
      return;
    }
    if (target.pathname !== "/rpc") {
      refuseUpgrade(socket, NOT_FOUND_RESPONSE);
      return;
    }
    if (rawTarget.includes("?")) {
      refuseUpgrade(socket, BAD_REQUEST_RESPONSE);
      return;
    }
    if (closing) {
      refuseUpgrade(socket, UNAVAILABLE_RESPONSE);
      return;
    }
    wss.handleUpgrade(request, socket, head, acceptClient);
  };

  return {
    handleUpgrade,
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const state of clients) {
          clearAuthTimer(state);
          if (!state.authenticated) {
            detach(state);
            state.ws.terminate();
          }
        }
        while ([...clients].some((state) => state.requestTasks.size !== 0)) {
          await Promise.all([...clients].flatMap((state) => [...state.requestTasks]));
        }
        await Promise.all([...clients].map((state) => state.sendTail));
        const authenticated = [...clients].filter((state) => state.authenticated);
        for (const state of authenticated) {
          if (state.ws.readyState === WebSocket.OPEN) state.ws.close(1001);
          detach(state);
        }
        await Promise.all(authenticated.map((state) => state.closedPromise));
        await new Promise<void>((resolve, reject) => {
          wss.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
        clients.clear();
      })();
      return closePromise;
    },
  };
}
