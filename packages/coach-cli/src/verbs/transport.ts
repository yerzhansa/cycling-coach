import {
  CoachTurnEventNotificationEnvelopeSchema,
  COACH_RPC_METHOD_REGISTRY,
  COACH_TURN_EVENT_NOTIFICATION_METHOD,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  serializeCoachRpcEnvelope,
  type CoachEngine,
  type JsonValue,
  type JsonRpcResponseEnvelope,
} from "@enduragent/coach-contract";
import {
  CoachClientBackpressureError,
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientTransportUnavailableError,
  CoachClientVersionMismatchError,
  CoachRpcRemoteError,
  connectCoachClient,
  type CoachClient,
  type CoachClientTerminalEnvelope,
  type ConnectCoachClientOptions,
} from "@enduragent/coach-client";
import {
  CoachRemoteError,
  type CoachRemoteFailure,
  type CoachVerbMethodName,
  type CoachVerbRequest,
  type CoachVerbTransport,
  type RemoteTransportDependencies,
} from "./types.js";

function assertNever(value: never): never {
  throw new TypeError(`Unexpected value: ${String(value)}`);
}

function remoteFailure(error: unknown, admitted: boolean): CoachRemoteFailure {
  if (error instanceof CoachClientVersionMismatchError) {
    return { kind: "version-mismatch", direction: error.direction };
  }
  if (error instanceof CoachRpcRemoteError) return { kind: "agent" };
  if (
    error instanceof CoachClientCallAbortedError ||
    error instanceof CoachClientCallTimeoutError
  ) {
    return { kind: "detached" };
  }
  if (error instanceof CoachClientDisconnectedError) {
    return { kind: admitted ? "detached" : "unavailable" };
  }
  if (error instanceof CoachClientBackpressureError) return { kind: "unavailable" };
  if (error instanceof CoachClientTransportUnavailableError) return { kind: "unavailable" };
  if (error instanceof CoachClientHandshakeError || error instanceof CoachClientProtocolError) {
    return { kind: admitted ? "agent" : "unavailable" };
  }
  return { kind: admitted ? "agent" : "unavailable" };
}

function createRemoteTransport(client: CoachClient): CoachVerbTransport {
  let admitted = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    const promise = closePromise ?? client.close();
    closePromise = promise;
    return promise;
  };

  return {
    kind: "remote",
    async request(input) {
      if (admitted) throw new CoachRemoteError({ kind: "agent" });
      if (input.signal.aborted) throw new CoachRemoteError({ kind: "detached" });
      let observedTerminal: JsonRpcResponseEnvelope | undefined;
      admitted = true;
      try {
        const onTerminalEnvelope = (envelope: CoachClientTerminalEnvelope): void => {
          observedTerminal = envelope;
          input.onTerminalEnvelope(envelope);
        };
        if (input.method === "chat") {
          await client.call("chat", input.params, {
            signal: input.signal,
            onNotificationEnvelope: input.onNotificationEnvelope,
            onTerminalEnvelope,
          });
        } else if (input.method === "getAthleteState") {
          await client.call("getAthleteState", input.params, {
            signal: input.signal,
            onNotificationEnvelope: input.onNotificationEnvelope,
            onTerminalEnvelope,
          });
        } else if (input.method === "importFiles") {
          await client.call("importFiles", input.params, {
            signal: input.signal,
            onNotificationEnvelope: input.onNotificationEnvelope,
            onTerminalEnvelope,
          });
        } else {
          await client.call("sync", input.params, {
            signal: input.signal,
            onNotificationEnvelope: input.onNotificationEnvelope,
            onTerminalEnvelope,
          });
        }
      } catch (error) {
        if (observedTerminal !== undefined) return observedTerminal;
        throw new CoachRemoteError(remoteFailure(error, admitted));
      }
      if (observedTerminal === undefined) throw new CoachRemoteError({ kind: "agent" });
      return observedTerminal;
    },
    close,
  };
}

export async function connectCoachVerbTransport(
  options: ConnectCoachClientOptions,
): Promise<CoachVerbTransport> {
  try {
    return createRemoteTransport(await connectCoachClient(options));
  } catch (error) {
    throw new CoachRemoteError(remoteFailure(error, false));
  }
}

async function invokeLocal(
  engine: CoachEngine,
  input: CoachVerbRequest,
  deliverEvent: (event: unknown) => void,
): Promise<unknown> {
  switch (input.method) {
    case "chat": {
      const params = COACH_RPC_METHOD_REGISTRY.chat.requestSchema.parse(input.params);
      return engine.chat(params, deliverEvent);
    }
    case "getAthleteState": {
      COACH_RPC_METHOD_REGISTRY.getAthleteState.requestSchema.parse(input.params);
      return engine.getAthleteState();
    }
    case "importFiles":
    case "sync":
      throw new TypeError("operational commands require the remote service");
    default:
      return assertNever(input);
  }
}

function localSuccess(method: CoachVerbMethodName, result: unknown) {
  const parsedResult = COACH_RPC_METHOD_REGISTRY[method].responseSchema.parse(result);
  const envelope = JsonRpcSuccessResponseEnvelopeSchema.parse({
    jsonrpc: "2.0",
    id: 1,
    result: parsedResult,
  });
  serializeCoachRpcEnvelope(envelope);
  return envelope;
}

function localError(data?: JsonValue) {
  const envelope = JsonRpcErrorResponseEnvelopeSchema.parse({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32603,
      message: "Internal error",
      ...(data === undefined ? {} : { data }),
    },
  });
  serializeCoachRpcEnvelope(envelope);
  return envelope;
}

export function createLocalCoachVerbTransport(
  engine: CoachEngine,
  serializeError?: (error: unknown) => JsonValue,
): CoachVerbTransport {
  let admitted = false;
  const closed = Promise.resolve();
  return {
    kind: "local",
    async request(input) {
      if (admitted) throw new CoachRemoteError({ kind: "agent" });
      admitted = true;
      if (input.signal.aborted) throw new CoachRemoteError({ kind: "detached" });
      let deliveryDetached = false;
      const onAbort = (): void => {
        deliveryDetached = true;
      };
      if (input.method === "chat") {
        input.signal.addEventListener("abort", onAbort, { once: true });
        if (input.signal.aborted) deliveryDetached = true;
      }
      let envelope: ReturnType<typeof localSuccess> | ReturnType<typeof localError>;
      try {
        try {
          const result = await invokeLocal(engine, input, (rawEvent) => {
            if (deliveryDetached || input.method !== "chat") return;
            const event = COACH_RPC_METHOD_REGISTRY.chat.eventSchema.parse(rawEvent);
            const notification = CoachTurnEventNotificationEnvelopeSchema.parse({
              jsonrpc: "2.0",
              method: COACH_TURN_EVENT_NOTIFICATION_METHOD,
              params: {
                requestId: 1,
                requestMethod: "chat",
                turnId: event.turnId,
                event,
              },
            });
            serializeCoachRpcEnvelope(notification);
            input.onNotificationEnvelope(notification);
          });
          envelope = localSuccess(input.method, result);
        } catch (error) {
          envelope = localError(serializeError?.(error));
        }
        if (deliveryDetached) throw new CoachRemoteError({ kind: "detached" });
        input.onTerminalEnvelope(envelope);
        return envelope;
      } finally {
        if (input.method === "chat") input.signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => closed,
  };
}

function unavailable(error: unknown): error is CoachRemoteError {
  return error instanceof CoachRemoteError && error.failure.kind === "unavailable";
}

export interface BoundedConnectDependencies {
  readonly connect: () => Promise<CoachVerbTransport>;
  readonly delay: (ms: number) => Promise<void>;
  readonly monotonicNow: () => number;
}

export interface ServiceAwareRemoteTransportDependencies extends RemoteTransportDependencies {
  readonly resumeService?: () => Promise<"resumed" | "not-installed">;
}

export async function connectWithBoundedRetry(
  dependencies: BoundedConnectDependencies,
): Promise<CoachVerbTransport> {
  const startedAt = dependencies.monotonicNow();
  let nextDelayMs = 50;
  while (true) {
    try {
      return await dependencies.connect();
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    const beforeDelay = dependencies.monotonicNow() - startedAt;
    if (beforeDelay >= 5_000) throw new CoachRemoteError({ kind: "unavailable" });
    await dependencies.delay(Math.min(nextDelayMs, 5_000 - beforeDelay));
    const afterDelay = dependencies.monotonicNow() - startedAt;
    if (afterDelay >= 5_000) throw new CoachRemoteError({ kind: "unavailable" });
    nextDelayMs = Math.min(nextDelayMs * 2, 200);
  }
}

export async function connectRemoteCoachTransport(
  dependencies: ServiceAwareRemoteTransportDependencies,
): Promise<CoachVerbTransport> {
  try {
    return await dependencies.connect();
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  const registration = await dependencies.serviceRegistrationState();
  if (registration === "unknown") throw new CoachRemoteError({ kind: "unavailable" });
  if (registration === "present") {
    if (dependencies.resumeService === undefined) {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    const resumed = await dependencies.resumeService();
    if (resumed !== "resumed") throw new CoachRemoteError({ kind: "unavailable" });
    return connectWithBoundedRetry(dependencies);
  }
  const child = await dependencies.startEphemeralDaemon();
  try {
    const transport = await connectWithBoundedRetry(dependencies);
    child.detachAfterHealthy();
    return transport;
  } catch (error) {
    await child.disposeAfterFailedStart();
    throw error;
  }
}
