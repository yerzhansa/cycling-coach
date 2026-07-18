import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  EXIT_AGENT_ERROR,
  EXIT_SUCCESS,
  type CoachEngine,
  type ExitCode,
} from "@enduragent/coach-contract";

export interface CoachCliTerminal {
  readonly input: NodeJS.ReadableStream;
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
  readonly isTTY: boolean;
}

export interface RunCoachReplOptions {
  readonly engine: CoachEngine;
  readonly terminal: CoachCliTerminal;
  readonly signal: AbortSignal;
  readonly createSessionId?: () => string;
}

export async function runCoachRepl(options: RunCoachReplOptions): Promise<ExitCode> {
  let sessionId: string;
  try {
    const createdId = (options.createSessionId ?? randomUUID)();
    if (createdId.length === 0) throw new TypeError("empty session id");
    sessionId = `cli:${createdId}`;
  } catch {
    options.terminal.stderr.write("Enduragent could not start a chat session.\n");
    return EXIT_AGENT_ERROR;
  }

  let stopping = options.signal.aborted;
  if (stopping) return EXIT_SUCCESS;

  const input = options.terminal.input;
  let inputEnded =
    (input as NodeJS.ReadableStream & { readonly readableEnded?: boolean }).readableEnded === true;
  const onInputEnd = (): void => {
    inputEnded = true;
  };
  input.once("end", onInputEnd);

  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const onAbort = (): void => {
    stopping = true;
    rl.close();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  let exitCode: ExitCode = EXIT_SUCCESS;
  try {
    if (options.terminal.isTTY) {
      options.terminal.stderr.write("Enduragent chat. Type /quit or /exit to quit.\n");
      options.terminal.stderr.write("> ");
    }

    if (!stopping) {
      for await (const line of rl) {
        if (stopping) break;
        const message = line.trim();
        if (message.length === 0) {
          if (options.terminal.isTTY && !inputEnded && !stopping) {
            options.terminal.stderr.write("> ");
          }
          continue;
        }
        if (message === "/quit" || message === "/exit") {
          rl.close();
          break;
        }
        try {
          const response = await options.engine.chat({ chatId: sessionId, message });
          options.terminal.stdout.write(`${response.text}\n`);
        } catch {
          options.terminal.stderr.write("Enduragent could not complete this turn.\n");
          exitCode = EXIT_AGENT_ERROR;
          stopping = true;
          rl.close();
        }
        if (stopping) break;
        if (options.terminal.isTTY && !inputEnded) {
          options.terminal.stderr.write("> ");
        }
      }
    }
  } finally {
    rl.close();
    options.signal.removeEventListener("abort", onAbort);
    input.removeListener("end", onInputEnd);
  }
  return exitCode;
}
