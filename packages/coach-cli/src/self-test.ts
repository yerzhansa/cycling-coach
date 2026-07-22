import {
  EXIT_AGENT_ERROR,
  EXIT_CHECKSUM_MISMATCH,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_VERSION_MISMATCH,
  SELF_TEST_SCHEMA_VERSION,
  SELF_TEST_TERMINAL_TYPE,
  CoachOperationProgressNotificationEnvelopeSchema,
  SelfTestCommandTerminalSchema,
  SelfTestRpcResultSchema,
  type ExitCode,
  type SelfTestCommandTerminal,
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
  connectCoachClient,
  type CoachClient,
  type ConnectCoachClientOptions,
} from "@enduragent/coach-client";
import type { CoachCliTerminal } from "./repl.js";
import { CoachRemoteError } from "./verbs/types.js";

export interface RunCoachSelfTestInput {
  readonly connect: () => Promise<CoachClient>;
  readonly terminal: Pick<CoachCliTerminal, "stdout" | "stderr">;
}

function fixedError(
  code: "RUNNER_ERROR" | "DAEMON_UNAVAILABLE" | "VERSION_MISMATCH",
): SelfTestCommandTerminal {
  const message =
    code === "RUNNER_ERROR"
      ? "packaged self-test failed"
      : code === "DAEMON_UNAVAILABLE"
        ? "Enduragent could not reach the local service."
        : "Enduragent protocol versions do not match; update this client.";
  return {
    schemaVersion: SELF_TEST_SCHEMA_VERSION,
    type: SELF_TEST_TERMINAL_TYPE,
    ok: false,
    error: { code, message },
  } as SelfTestCommandTerminal;
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => same(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && same(leftRecord[key], rightRecord[key]),
    )
  );
}

function errorTerminal(error: unknown): SelfTestCommandTerminal {
  if (
    error instanceof CoachClientVersionMismatchError ||
    (error instanceof CoachRemoteError && error.failure.kind === "version-mismatch")
  ) {
    return fixedError("VERSION_MISMATCH");
  }
  if (
    error instanceof CoachClientTransportUnavailableError ||
    error instanceof CoachClientHandshakeError ||
    error instanceof CoachClientDisconnectedError ||
    error instanceof CoachClientCallTimeoutError ||
    error instanceof CoachClientCallAbortedError ||
    error instanceof CoachClientBackpressureError ||
    (error instanceof CoachRemoteError && error.failure.kind === "unavailable")
  ) {
    return fixedError("DAEMON_UNAVAILABLE");
  }
  return fixedError("RUNNER_ERROR");
}

function exitCode(terminal: SelfTestCommandTerminal): ExitCode {
  if (terminal.ok) return EXIT_SUCCESS;
  switch (terminal.error.code) {
    case "CHECKSUM_MISMATCH":
      return EXIT_CHECKSUM_MISMATCH;
    case "DAEMON_UNAVAILABLE":
      return EXIT_DAEMON_UNAVAILABLE;
    case "VERSION_MISMATCH":
      return EXIT_VERSION_MISMATCH;
    default:
      return EXIT_AGENT_ERROR;
  }
}

export async function connectCoachSelfTestClient(
  options: ConnectCoachClientOptions,
): Promise<CoachClient> {
  try {
    return await connectCoachClient(options);
  } catch (error) {
    if (error instanceof CoachClientVersionMismatchError) {
      throw new CoachRemoteError({ kind: "version-mismatch", direction: error.direction });
    }
    throw new CoachRemoteError({ kind: "unavailable" });
  }
}

export async function runCoachSelfTest(input: RunCoachSelfTestInput): Promise<ExitCode> {
  let client: CoachClient | undefined;
  let terminal: SelfTestCommandTerminal;
  try {
    client = await input.connect();
    const events: unknown[] = [];
    const notifications: unknown[] = [];
    const terminals: unknown[] = [];
    const returned = await client.call(
      "selfTest",
      {},
      {
        onEvent: (event) => events.push(event),
        onNotificationEnvelope: (envelope) => notifications.push(envelope),
        onTerminalEnvelope: (envelope) => terminals.push(envelope),
      },
    );
    const expectedEvents = [
      { phase: "started", completed: 0, total: 1 },
      { phase: "completed", completed: 1, total: 1 },
    ];
    if (!same(events, expectedEvents) || notifications.length !== 2 || terminals.length !== 1) {
      throw new CoachClientProtocolError();
    }
    const parsedNotifications = notifications.map((value) =>
      CoachOperationProgressNotificationEnvelopeSchema.parse(value),
    );
    if (
      parsedNotifications.some((value) => value.params.requestMethod !== "selfTest") ||
      !same(
        parsedNotifications.map((value) => value.params.event),
        expectedEvents,
      ) ||
      !Object.is(parsedNotifications[0]!.params.requestId, parsedNotifications[1]!.params.requestId)
    ) {
      throw new CoachClientProtocolError();
    }
    const observed = terminals[0];
    if (
      observed === null ||
      typeof observed !== "object" ||
      !("result" in observed) ||
      !same(
        SelfTestRpcResultSchema.parse((observed as { readonly result: unknown }).result),
        returned,
      )
    ) {
      throw new CoachClientProtocolError();
    }
    terminal = SelfTestRpcResultSchema.parse(returned);
  } catch (error) {
    terminal = errorTerminal(error);
  } finally {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        if (terminal!.ok) terminal = fixedError("RUNNER_ERROR");
      }
    }
  }
  const parsed = SelfTestCommandTerminalSchema.parse(terminal!);
  input.terminal.stdout.write(`${JSON.stringify(parsed)}\n`);
  return exitCode(parsed);
}
