import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_AGENT_ERROR,
  EXIT_SUCCESS,
  type AthleteState,
  type CoachEngine,
} from "@enduragent/coach-contract";
import { parseCoachCliInvocation } from "../src/args.js";
import { runCoachRepl, type CoachCliTerminal } from "../src/repl.js";

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
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function terminal(
  input = new PassThrough(),
  isTTY = false,
): {
  readonly input: PassThrough;
  readonly stdout: ReturnType<typeof capture>;
  readonly stderr: ReturnType<typeof capture>;
  readonly value: CoachCliTerminal;
} {
  const stdout = capture();
  const stderr = capture();
  return {
    input,
    stdout,
    stderr,
    value: { input, stdout: stdout.stream, stderr: stderr.stream, isTTY },
  };
}

function mockEngine(
  implementation: CoachEngine["chat"] = async ({ message }) => ({ text: `${message}-response` }),
): {
  readonly engine: CoachEngine;
  readonly chat: ReturnType<typeof vi.fn<CoachEngine["chat"]>>;
  readonly resetSession: ReturnType<typeof vi.fn<CoachEngine["resetSession"]>>;
  readonly hasSession: ReturnType<typeof vi.fn<CoachEngine["hasSession"]>>;
} {
  const chat = vi.fn<CoachEngine["chat"]>(implementation);
  const resetSession = vi.fn<CoachEngine["resetSession"]>(async () => ({
    memoryFlushed: true,
  }));
  const hasSession = vi.fn<CoachEngine["hasSession"]>(async () => ({
    hasSession: false,
  }));
  const getAthleteState = vi.fn<CoachEngine["getAthleteState"]>(async () => state);
  return {
    engine: { chat, resetSession, hasSession, getAthleteState },
    chat,
    resetSession,
    hasSession,
  };
}

describe("coach CLI contract", () => {
  it("maps the complete argument matrix", () => {
    expect(parseCoachCliInvocation([])).toEqual({ kind: "repl" });
    expect(parseCoachCliInvocation(["version"])).toEqual({ kind: "version" });
    expect(parseCoachCliInvocation(["--version"])).toEqual({ kind: "version" });
    for (const argv of [["unknown"], ["version", "extra"], ["--version", "extra"], [""]]) {
      expect(parseCoachCliInvocation(argv)).toEqual({
        kind: "usage",
        message: "Usage: enduragent [version]",
      });
    }
  });

  it("pins one fresh session per invocation and contains factory failures", async () => {
    const firstTerminal = terminal();
    firstTerminal.input.end("one\ntwo\n");
    const first = mockEngine();
    await expect(
      runCoachRepl({
        engine: first.engine,
        terminal: firstTerminal.value,
        signal: new AbortController().signal,
        createSessionId: () => "first-id",
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(first.chat.mock.calls.map(([request]) => request)).toEqual([
      { chatId: "cli:first-id", message: "one" },
      { chatId: "cli:first-id", message: "two" },
    ]);
    expect(first.hasSession).not.toHaveBeenCalled();
    expect(first.resetSession).not.toHaveBeenCalled();

    const secondTerminal = terminal();
    secondTerminal.input.end("three\n");
    const second = mockEngine();
    await runCoachRepl({
      engine: second.engine,
      terminal: secondTerminal.value,
      signal: new AbortController().signal,
      createSessionId: () => "second-id",
    });
    expect(second.chat).toHaveBeenCalledWith({
      chatId: "cli:second-id",
      message: "three",
    });

    for (const createSessionId of [
      () => "",
      () => {
        throw new Error("private");
      },
    ]) {
      const failedTerminal = terminal();
      const failed = mockEngine();
      await expect(
        runCoachRepl({
          engine: failed.engine,
          terminal: failedTerminal.value,
          signal: new AbortController().signal,
          createSessionId,
        }),
      ).resolves.toBe(EXIT_AGENT_ERROR);
      expect(failed.chat).not.toHaveBeenCalled();
      expect(failedTerminal.stdout.read()).toBe("");
      expect(failedTerminal.stderr.read()).toBe("Enduragent could not start a chat session.\n");
    }
  });

  it("serializes non-TTY turns in FIFO order", async () => {
    const firstResponse = deferred<{ text: string }>();
    const secondResponse = deferred<{ text: string }>();
    const mocked = mockEngine(async ({ message }) =>
      message === "first" ? firstResponse.promise : secondResponse.promise,
    );
    const io = terminal();
    io.input.end("first\nsecond\n");
    const result = runCoachRepl({
      engine: mocked.engine,
      terminal: io.value,
      signal: new AbortController().signal,
      createSessionId: () => "fifo",
    });
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    expect(mocked.chat.mock.calls[0]?.[0].message).toBe("first");
    firstResponse.resolve({ text: "first-response" });
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(2));
    expect(mocked.chat.mock.calls[1]?.[0].message).toBe("second");
    secondResponse.resolve({ text: "second-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(io.stdout.read()).toBe("first-response\nsecond-response\n");
    expect(io.stderr.read()).toBe("");
  });

  it("drains the final turn after physical EOF before returning", async () => {
    const trace: string[] = [];
    const response = deferred<{ text: string }>();
    const mocked = mockEngine(async () => response.promise);
    const io = terminal();
    io.input.once("end", () => trace.push("input-end"));
    const result = runCoachRepl({
      engine: mocked.engine,
      terminal: io.value,
      signal: new AbortController().signal,
      createSessionId: () => "drain",
    }).then((code) => {
      trace.push("repl-return");
      return code;
    });
    io.input.end("final\n");
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(trace).toContain("input-end"));
    expect(trace).not.toContain("repl-return");
    response.resolve({ text: "final-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(trace).toEqual(["input-end", "repl-return"]);
    expect(io.stdout.read()).toBe("final-response\n");
  });

  it("renders byte-exact TTY and control transcripts", async () => {
    const banner = "Enduragent chat. Type /quit or /exit to quit.\n";

    const successful = terminal(new PassThrough(), true);
    const response = deferred<{ text: string }>();
    const successEngine = mockEngine(async () => response.promise);
    const successResult = runCoachRepl({
      engine: successEngine.engine,
      terminal: successful.value,
      signal: new AbortController().signal,
      createSessionId: () => "tty-success",
    });
    successful.input.write("hello\n");
    await vi.waitFor(() => expect(successEngine.chat).toHaveBeenCalledTimes(1));
    response.resolve({ text: "reply" });
    await vi.waitFor(() => expect(successful.stdout.read()).toBe("reply\n"));
    successful.input.write("/quit\n");
    await expect(successResult).resolves.toBe(EXIT_SUCCESS);
    expect(successful.stderr.read()).toBe(`${banner}> > `);

    const blank = terminal(new PassThrough(), true);
    const blankEngine = mockEngine();
    const blankResult = runCoachRepl({
      engine: blankEngine.engine,
      terminal: blank.value,
      signal: new AbortController().signal,
      createSessionId: () => "tty-blank",
    });
    blank.input.write("   \n/quit\n");
    await expect(blankResult).resolves.toBe(EXIT_SUCCESS);
    expect(blank.stderr.read()).toBe(`${banner}> > `);
    expect(blankEngine.chat).not.toHaveBeenCalled();

    const immediateEof = terminal(new PassThrough(), true);
    const eofEngine = mockEngine();
    immediateEof.input.end();
    await expect(
      runCoachRepl({
        engine: eofEngine.engine,
        terminal: immediateEof.value,
        signal: new AbortController().signal,
        createSessionId: () => "tty-eof",
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(immediateEof.stderr.read()).toBe(`${banner}> `);

    const inflightEof = terminal(new PassThrough(), true);
    const inflightResponse = deferred<{ text: string }>();
    const inflightEngine = mockEngine(async () => inflightResponse.promise);
    inflightEof.input.end("hello\n");
    const inflightResult = runCoachRepl({
      engine: inflightEngine.engine,
      terminal: inflightEof.value,
      signal: new AbortController().signal,
      createSessionId: () => "tty-inflight",
    });
    await vi.waitFor(() => expect(inflightEngine.chat).toHaveBeenCalledTimes(1));
    inflightResponse.resolve({ text: "reply" });
    await expect(inflightResult).resolves.toBe(EXIT_SUCCESS);
    expect(inflightEof.stderr.read()).toBe(`${banner}> `);
    expect(inflightEof.stdout.read()).toBe("reply\n");

    const exitControl = terminal();
    exitControl.input.end("/exit\n");
    const exitEngine = mockEngine();
    await runCoachRepl({
      engine: exitEngine.engine,
      terminal: exitControl.value,
      signal: new AbortController().signal,
      createSessionId: () => "exit-control",
    });
    expect(exitEngine.chat).not.toHaveBeenCalled();
  });

  it("drains aborts, discards queued lines, removes listeners, and redacts errors", async () => {
    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const preAbortedTerminal = terminal();
    const preAbortedEngine = mockEngine();
    const factory = vi.fn(() => "pre-aborted");
    await expect(
      runCoachRepl({
        engine: preAbortedEngine.engine,
        terminal: preAbortedTerminal.value,
        signal: preAbortedController.signal,
        createSessionId: factory,
      }),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(preAbortedEngine.chat).not.toHaveBeenCalled();
    expect(preAbortedTerminal.stdout.read()).toBe("");
    expect(preAbortedTerminal.stderr.read()).toBe("");

    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const io = terminal();
    const response = deferred<{ text: string }>();
    const mocked = mockEngine(async () => response.promise);
    const result = runCoachRepl({
      engine: mocked.engine,
      terminal: io.value,
      signal: controller.signal,
      createSessionId: () => "abort",
    });
    io.input.write("first\nsecond\n");
    await vi.waitFor(() => expect(mocked.chat).toHaveBeenCalledTimes(1));
    controller.abort();
    response.resolve({ text: "first-response" });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(mocked.chat).toHaveBeenCalledTimes(1);
    expect(io.stdout.read()).toBe("first-response\n");
    expect(io.input.listenerCount("end")).toBe(0);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);

    const errorController = new AbortController();
    const errorIo = terminal();
    const failure = deferred<{ text: string }>();
    const errorEngine = mockEngine(async () => failure.promise);
    const errorResult = runCoachRepl({
      engine: errorEngine.engine,
      terminal: errorIo.value,
      signal: errorController.signal,
      createSessionId: () => "error",
    });
    errorIo.input.write("first\nsecond\n");
    await vi.waitFor(() => expect(errorEngine.chat).toHaveBeenCalledTimes(1));
    errorController.abort();
    failure.reject(new Error("private turn detail"));
    await expect(errorResult).resolves.toBe(EXIT_AGENT_ERROR);
    expect(errorEngine.chat).toHaveBeenCalledTimes(1);
    expect(errorIo.stdout.read()).toBe("");
    expect(errorIo.stderr.read()).toBe("Enduragent could not complete this turn.\n");
  });
});
