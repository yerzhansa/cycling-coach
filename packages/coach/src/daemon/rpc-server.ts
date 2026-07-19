import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  ClientHandshakeFrameSchema,
  COACH_RPC_METHOD_REGISTRY,
  CoachOperationProgressNotificationEnvelopeSchema,
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
  type CoachOperations,
  type CoachRpcMethodName,
  type CoachSelfTestOperations,
  type DaemonOwner,
  type GetSpendSummaryRpcParams,
  type JsonRpcId,
  type SetDailySpendCapRpcParams,
  type SpendSummary,
} from "@enduragent/coach-contract";
import type { WriterProtocolHandlers } from "@enduragent/kernel-node/lock";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { DaemonHealthState } from "./healthz-server.js";
import { DetachedSessionRequestError, createSessionRequestQueue } from "./session-queue.js";
import { HANDOFF_CAPABILITY_BYTES, type MonotonicTimer } from "./upgrade-fence.js";
import { serializeBoundaryError } from "./error-boundary.js";

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

export const UPGRADE_DRAIN_TIMEOUT_MS = 30_000 as const;

export type UpgradeDrainOutcome = { readonly status: "accepted" } | { readonly status: "timeout" };

export interface UpgradeDrainCoordinator {
  shutdownForUpgrade(input: {
    readonly connectionId: string;
    readonly targetProtocolVersion: number;
    readonly handoffCapability: string;
    readonly deadlineMs: number;
    readonly timer: MonotonicTimer;
  }): Promise<UpgradeDrainOutcome>;
}

export interface UpgradeReservation {
  readonly connectionId: string;
  readonly targetProtocolVersion: number;
  readonly handoffCapabilityBytes: Buffer;
  readonly state: "reserved" | "shutdown-consumed";
}

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
  readonly operations: CoachOperations;
  readonly spend: SpendRpcHandlers;
  readonly selfTestOperations: CoachSelfTestOperations;
  readonly token: string;
  readonly owner: DaemonOwner;
  readonly healthState?: DaemonHealthState;
  readonly timer?: MonotonicTimer;
}

export interface SpendRpcHandlers {
  readonly getSpendSummary: (params: GetSpendSummaryRpcParams) => Promise<SpendSummary>;
  readonly setDailySpendCap: (params: SetDailySpendCapRpcParams) => Promise<SpendSummary>;
}

export interface CoachRpcServer {
  readonly handleUpgrade: WriterProtocolHandlers["upgrade"];
  readonly shutdownRequested: Promise<void>;
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
  readonly detachController: AbortController;
  readonly connectionId: string;
  sendTail: Promise<void>;
  authTimer: ReturnType<typeof setTimeout> | undefined;
  authenticated: boolean;
  detached: boolean;
  closed: boolean;
}

function createClientState(ws: WebSocket, connectionId: string): ClientState {
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
    detachController: new AbortController(),
    connectionId,
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
    state.detachController.abort();
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
          if (error != null) detach(state, 1013, "backpressure");
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

function internalError(id: JsonRpcId, error: unknown): string {
  return serializeCoachRpcEnvelope(
    JsonRpcErrorResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: "Internal error",
        data: serializeBoundaryError(error),
      },
    }),
  );
}

function ordinarySuccess(id: JsonRpcId, result: unknown): string {
  return serializeCoachRpcEnvelope(
    JsonRpcSuccessResponseEnvelopeSchema.parse({ jsonrpc: "2.0", id, result }),
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

function productionTimer(): MonotonicTimer {
  return {
    nowMs: () => performance.now(),
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, Math.max(0, delayMs));
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

function canonicalCapability(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== HANDOFF_CAPABILITY_BYTES || decoded.toString("base64url") !== value) {
    return undefined;
  }
  return decoded;
}

function controlParams(value: unknown):
  | {
      readonly targetProtocolVersion: number;
      readonly handoffCapability: string;
    }
  | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "handoffCapability" ||
    keys[1] !== "targetProtocolVersion" ||
    !Number.isSafeInteger(record.targetProtocolVersion) ||
    (record.targetProtocolVersion as number) < 0 ||
    typeof record.handoffCapability !== "string"
  ) {
    return undefined;
  }
  return {
    targetProtocolVersion: record.targetProtocolVersion as number,
    handoffCapability: record.handoffCapability,
  };
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
  const sessionQueue = createSessionRequestQueue();
  const coachingTasks = new Set<Promise<void>>();
  const timer = input.timer ?? productionTimer();
  let closing = false;
  let acceptingCoaching = true;
  let closePromise: Promise<void> | undefined;
  let reservation: UpgradeReservation | undefined;
  let connectionSequence = 0;
  let resolveShutdownRequested!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdownRequested = resolve;
  });

  const clearReservation = (): void => {
    reservation?.handoffCapabilityBytes.fill(0);
    reservation = undefined;
  };

  const awaitDrain = (
    deadlineMs: number,
    state: ClientState,
  ): Promise<UpgradeDrainOutcome | { readonly status: "connection-closed" }> => {
    const tasks = [...coachingTasks];
    if (tasks.length === 0) {
      return Promise.resolve(
        state.detached ? { status: "connection-closed" } : { status: "accepted" },
      );
    }
    return new Promise((resolve) => {
      let settled = false;
      const deadline = timer.schedule(Math.max(0, deadlineMs - timer.nowMs()), () => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        resolve({ status: "timeout" });
      });
      void Promise.all(tasks).then(() => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        resolve({ status: "accepted" });
      });
      void state.detachedPromise.then(() => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        resolve({ status: "connection-closed" });
      });
    });
  };

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
    if (
      generic.data.method === "daemon.reserveUpgrade" ||
      generic.data.method === "daemon.shutdownForUpgrade"
    ) {
      const params = controlParams(generic.data.params);
      if (params === undefined) {
        void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
        return;
      }
      if (generic.data.method === "daemon.reserveUpgrade") {
        const capability = canonicalCapability(params.handoffCapability);
        if (
          reservation !== undefined ||
          capability === undefined ||
          params.targetProtocolVersion <= PROTOCOL_VERSION ||
          input.owner === "unmanaged-foreground"
        ) {
          void enqueueSerialized(
            state,
            ordinaryError(generic.data.id, -32_003, "handoff-reservation-refused"),
          );
          return;
        }
        reservation = {
          connectionId: state.connectionId,
          targetProtocolVersion: params.targetProtocolVersion,
          handoffCapabilityBytes: Buffer.from(capability),
          state: "reserved",
        };
        capability.fill(0);
        void enqueueSerialized(state, ordinarySuccess(generic.data.id, { status: "reserved" }));
        return;
      }
      const capability = canonicalCapability(params.handoffCapability);
      const activeReservation = reservation;
      if (
        capability === undefined ||
        activeReservation === undefined ||
        activeReservation.state !== "reserved" ||
        activeReservation.connectionId !== state.connectionId ||
        activeReservation.targetProtocolVersion !== params.targetProtocolVersion ||
        capability.length !== activeReservation.handoffCapabilityBytes.length ||
        !timingSafeEqual(capability, activeReservation.handoffCapabilityBytes)
      ) {
        capability?.fill(0);
        void enqueueSerialized(
          state,
          ordinaryError(generic.data.id, -32_003, "handoff-reservation-refused"),
        );
        return;
      }
      capability.fill(0);
      reservation = { ...activeReservation, state: "shutdown-consumed" };
      acceptingCoaching = false;
      input.healthState?.setHealthy(false);
      const task = (async () => {
        const outcome = await awaitDrain(timer.nowMs() + UPGRADE_DRAIN_TIMEOUT_MS, state);
        if (outcome.status !== "accepted") {
          acceptingCoaching = true;
          input.healthState?.setHealthy(true);
          clearReservation();
          if (outcome.status === "timeout") {
            await enqueueSerialized(
              state,
              ordinaryError(generic.data.id, -32_004, "upgrade-drain-timeout"),
            );
          }
          return;
        }
        await enqueueSerialized(state, ordinarySuccess(generic.data.id, { status: "accepted" }));
        if (state.detached) {
          acceptingCoaching = true;
          input.healthState?.setHealthy(true);
          clearReservation();
          return;
        }
        clearReservation();
        resolveShutdownRequested();
      })();
      state.requestTasks.add(task);
      void task.finally(() => state.requestTasks.delete(task)).catch(() => {});
      return;
    }
    if (!acceptingCoaching) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32_005, "daemon-upgrading"));
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
      let invocationFailure: { readonly error: unknown } | undefined;
      let eventFailure: { readonly error: unknown } | undefined;
      let deliveryDetached = false;
      let result: unknown;
      try {
        switch (registry.wireName) {
          case "chat":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.chat.requestSchema.parse(
                generic.data.params,
              );
              result = await sessionQueue.run({
                key: request.chatId,
                signal: state.detachController.signal,
                run: () =>
                  input.engine.chat(request, (event) => {
                    if (eventFailure !== undefined) return;
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
                    } catch (error) {
                      eventFailure = { error };
                    }
                  }),
              });
            } catch (error) {
              if (error instanceof DetachedSessionRequestError) deliveryDetached = true;
              else invocationFailure = { error };
            }
            break;
          case "resetSession":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.resetSession.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.resetSession(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "hasSession":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.hasSession.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.hasSession(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getAthleteState":
            try {
              COACH_RPC_METHOD_REGISTRY.getAthleteState.requestSchema.parse(generic.data.params);
              result = await input.engine.getAthleteState();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "importFiles":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.importFiles.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.importFiles(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent =
                    COACH_RPC_METHOD_REGISTRY.importFiles.eventSchema.parse(event);
                  const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.operationProgress",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "importFiles",
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "sync":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.sync.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.sync(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY.sync.eventSchema.parse(event);
                  const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.operationProgress",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "sync",
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "saveIntake":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.saveIntake.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.saveIntake(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "configureRuntime":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.configureRuntime.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.configureRuntime(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getUnitsPreference":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getUnitsPreference.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.getUnitsPreference === undefined) {
                throw new TypeError("Units preference operation is unavailable.");
              }
              result = await input.operations.getUnitsPreference(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "setUnitsPreference":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.setUnitsPreference.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.setUnitsPreference === undefined) {
                throw new TypeError("Units preference operation is unavailable.");
              }
              result = await input.operations.setUnitsPreference(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getSpendSummary":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getSpendSummary.requestSchema.parse(
                generic.data.params,
              );
              result = await input.spend.getSpendSummary(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "setDailySpendCap":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.setDailySpendCap.requestSchema.parse(
                generic.data.params,
              );
              result = await input.spend.setDailySpendCap(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "selfTest":
            try {
              COACH_RPC_METHOD_REGISTRY.selfTest.requestSchema.parse(generic.data.params);
              result = await input.selfTestOperations.selfTest((event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY.selfTest.eventSchema.parse(event);
                  const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.operationProgress",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "selfTest",
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
        }
        if (deliveryDetached) return;
        let terminal: string;
        const failure = invocationFailure ?? eventFailure;
        if (failure !== undefined) {
          terminal = internalError(generic.data.id, failure.error);
        } else {
          const response = registry.responseSchema.safeParse(result);
          if (!response.success) {
            terminal = internalError(generic.data.id, response.error);
          } else {
            try {
              terminal = serializeCoachRpcEnvelope(
                JsonRpcSuccessResponseEnvelopeSchema.parse({
                  jsonrpc: "2.0",
                  id: generic.data.id,
                  result: response.data,
                }),
              );
            } catch (error) {
              terminal = internalError(generic.data.id, error);
            }
          }
        }
        await enqueueSerialized(state, terminal);
      } finally {
        state.activeIds.delete(key);
      }
    })();
    state.requestTasks.add(task);
    coachingTasks.add(task);
    void task
      .finally(() => {
        state.requestTasks.delete(task);
        coachingTasks.delete(task);
      })
      .catch(() => {});
  };

  const acceptClient = (ws: WebSocket): void => {
    connectionSequence += 1;
    const state = createClientState(ws, `connection-${connectionSequence}`);
    clients.add(state);
    ws.on("close", () => {
      clearAuthTimer(state);
      detach(state);
      if (reservation?.connectionId === state.connectionId && reservation.state === "reserved") {
        clearReservation();
      }
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
    if (
      Object.prototype.hasOwnProperty.call(request.headers, "origin") &&
      request.headers.origin !== "enduragent://app"
    ) {
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
    shutdownRequested,
    close() {
      closePromise ??= (async () => {
        closing = true;
        acceptingCoaching = false;
        input.healthState?.setHealthy(false);
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
        clearReservation();
        clients.clear();
      })();
      return closePromise;
    },
  };
}
