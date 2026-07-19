import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_VERSION_MISMATCH,
  type ExitCode,
} from "@enduragent/coach-contract";
import { createCoachVerbRenderer } from "./render.js";
import { CoachRemoteError, type CoachRemoteFailure, type RunCoachVerbInput } from "./types.js";

function assertNever(value: never): never {
  throw new TypeError(`Unexpected value: ${String(value)}`);
}

function renderRemoteFailure(failure: CoachRemoteFailure, input: RunCoachVerbInput): ExitCode {
  switch (failure.kind) {
    case "unavailable":
      input.terminal.stderr.write("Enduragent could not reach the local service.\n");
      return EXIT_DAEMON_UNAVAILABLE;
    case "version-mismatch":
      input.terminal.stderr.write(
        "Enduragent protocol versions do not match; update this client.\n",
      );
      return EXIT_VERSION_MISMATCH;
    case "agent":
      input.terminal.stderr.write("Enduragent could not complete this command.\n");
      return EXIT_AGENT_ERROR;
    case "detached":
      input.terminal.stderr.write(
        "Enduragent detached from the running turn; the turn may still complete.\n",
      );
      return EXIT_AGENT_ERROR;
    default:
      return assertNever(failure);
  }
}

export async function runCoachVerb(input: RunCoachVerbInput): Promise<ExitCode> {
  const renderer = createCoachVerbRenderer(input.outputMode, input.terminal);
  try {
    const request = {
      ...input.request,
      onNotificationEnvelope: renderer.onNotificationEnvelope,
      onTerminalEnvelope: renderer.onTerminalEnvelope,
    };
    const returnedTerminal = await input.transport.request(request);
    const observedTerminal = renderer.observedTerminal();
    if (observedTerminal === undefined || returnedTerminal !== observedTerminal) {
      throw new TypeError("command terminal envelope invariant failed");
    }
    if ("error" in returnedTerminal) {
      input.terminal.stderr.write("Enduragent could not complete this command.\n");
      return EXIT_AGENT_ERROR;
    }
    renderer.renderSuccess(input.request.method, returnedTerminal);
    return EXIT_SUCCESS;
  } catch (error) {
    if (error instanceof CoachRemoteError) {
      return renderRemoteFailure(error.failure, input);
    }
    throw error;
  }
}
