import type {
  CoachRpcMethodName,
  CoachRpcRequest,
  CoachTurnEventNotificationEnvelope,
  JsonRpcResponseEnvelope,
  ProtocolVersionDirection,
} from "@enduragent/coach-contract";
import type { CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import type { CoachCliOutputMode } from "../args.js";
import type { CoachCliTerminal } from "../repl.js";

export type CoachVerbMethodName = Extract<CoachRpcMethodName, "chat" | "getAthleteState">;

export type CoachVerbRequest = {
  readonly [K in CoachVerbMethodName]: {
    readonly method: K;
    readonly params: CoachRpcRequest<K>;
    readonly signal: AbortSignal;
    readonly onNotificationEnvelope: (envelope: CoachTurnEventNotificationEnvelope) => void;
    readonly onTerminalEnvelope: (envelope: CoachClientTerminalEnvelope) => void;
  };
}[CoachVerbMethodName];

export interface CoachVerbTransport {
  readonly kind: "remote" | "local";
  request(input: CoachVerbRequest): Promise<JsonRpcResponseEnvelope>;
  close(): Promise<void>;
}

export type CoachRemoteFailure =
  | { readonly kind: "unavailable" }
  | { readonly kind: "version-mismatch"; readonly direction: ProtocolVersionDirection }
  | { readonly kind: "agent" }
  | { readonly kind: "detached" };

export class CoachRemoteError extends Error {
  constructor(readonly failure: CoachRemoteFailure) {
    super(`Coach remote failure: ${failure.kind}`);
    this.name = "CoachRemoteError";
  }
}

export type ServiceRegistrationState = "present" | "absent" | "unknown";

export interface RemoteTransportDependencies {
  readonly connect: () => Promise<CoachVerbTransport>;
  readonly serviceRegistrationState: () => Promise<ServiceRegistrationState>;
  readonly startEphemeralDaemon: () => Promise<{
    readonly disposeAfterFailedStart: () => Promise<void>;
    readonly detachAfterHealthy: () => void;
  }>;
  readonly delay: (ms: number) => Promise<void>;
  readonly monotonicNow: () => number;
}

export interface RunCoachVerbInput {
  readonly request: CoachVerbRequest;
  readonly outputMode: CoachCliOutputMode;
  readonly terminal: Pick<CoachCliTerminal, "stdout" | "stderr">;
  readonly transport: CoachVerbTransport;
}
