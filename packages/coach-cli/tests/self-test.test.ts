import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_AGENT_ERROR,
  EXIT_CHECKSUM_MISMATCH,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_VERSION_MISMATCH,
  SelfTestCommandTerminalSchema,
  type SelfTestRpcResult,
} from "@enduragent/coach-contract";
import {
  CoachClientHandshakeError,
  CoachClientVersionMismatchError,
  type CoachClient,
  type CoachClientCallOptions,
} from "@enduragent/coach-client";
import { runCoachSelfTest } from "../src/self-test.js";

function capture() {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    read: () => text,
  };
}

function result(error?: SelfTestRpcResult extends infer T ? T : never): SelfTestRpcResult {
  if (error !== undefined) return error;
  const digest = "b".repeat(64);
  return {
    schemaVersion: 1,
    type: "self-test-terminal",
    ok: true,
    runtime: { node: "24.18.0", electron: "43.1.1", v8: "15.0" },
    resources: {
      algorithm: "sha256",
      matrixSha256: digest,
      insideAsarSha256: digest,
      extraResourcesSha256: digest,
      byteIdentical: true,
    },
    suites: {
      parity: { cases: 2, passed: 2 },
      differential: { cases: 3, passed: 3 },
    },
  };
}

function client(
  terminalResult: SelfTestRpcResult,
  input: { readonly close?: () => Promise<void>; readonly malformedProgress?: boolean } = {},
) {
  const call = vi.fn(
    async (_method: string, _params: unknown, options?: CoachClientCallOptions<"selfTest">) => {
      const started = { phase: "started", completed: 0, total: 1 } as const;
      const completed = { phase: "completed", completed: 1, total: 1 } as const;
      const events = input.malformedProgress ? [completed, started] : [started, completed];
      for (const event of events) {
        options?.onEvent?.(event);
        options?.onNotificationEnvelope?.({
          jsonrpc: "2.0",
          method: "coach.operationProgress",
          params: { requestId: 1, requestMethod: "selfTest", event },
        });
      }
      options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: terminalResult });
      return terminalResult;
    },
  );
  const close = vi.fn(input.close ?? (async () => {}));
  return { value: { call, close } as unknown as CoachClient, call, close };
}

async function invoke(connect: () => Promise<CoachClient>) {
  const stdout = capture();
  const stderr = capture();
  const exit = await runCoachSelfTest({
    connect,
    terminal: { stdout: stdout.stream, stderr: stderr.stream },
  });
  const lines = stdout.read().trimEnd().split("\n");
  return {
    exit,
    stdout: stdout.read(),
    stderr: stderr.read(),
    lines,
    terminal: SelfTestCommandTerminalSchema.parse(JSON.parse(lines[0]!)),
  };
}

describe("self-test command", () => {
  it("renders one validated success line after exact progress and close", async () => {
    const fake = client(result());
    const outcome = await invoke(async () => fake.value);
    expect(outcome.exit).toBe(EXIT_SUCCESS);
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.stdout.endsWith("\n")).toBe(true);
    expect(outcome.stderr).toBe("");
    expect(outcome.terminal.ok).toBe(true);
    expect(fake.call).toHaveBeenCalledWith("selfTest", {}, expect.any(Object));
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["CHECKSUM_MISMATCH", EXIT_CHECKSUM_MISMATCH],
    ["PARITY_MISMATCH", EXIT_AGENT_ERROR],
    ["DIFFERENTIAL_MISMATCH", EXIT_AGENT_ERROR],
    ["RUNNER_ERROR", EXIT_AGENT_ERROR],
  ] as const)("maps %s without changing its terminal", async (code, expectedExit) => {
    const failure: SelfTestRpcResult =
      code === "CHECKSUM_MISMATCH"
        ? {
            schemaVersion: 1,
            type: "self-test-terminal",
            ok: false,
            error: {
              code,
              message: "packaged self-test resource checksum mismatch",
              location: "extraResources",
              resource: "matrix.json",
              expectedSha256: "a".repeat(64),
              actualSha256: "b".repeat(64),
            },
          }
        : code === "RUNNER_ERROR"
          ? {
              schemaVersion: 1,
              type: "self-test-terminal",
              ok: false,
              error: { code, message: "packaged self-test failed" },
            }
          : {
              schemaVersion: 1,
              type: "self-test-terminal",
              ok: false,
              error: {
                code,
                message: "packaged self-test comparison failed",
                caseId: "case",
                fixture: "fixture",
                metric: "metric",
                path: "$",
              },
            };
    const fake = client(failure);
    const outcome = await invoke(async () => fake.value);
    expect(outcome.exit).toBe(expectedExit);
    expect(outcome.terminal).toEqual(failure);
    expect(outcome.stderr).toBe("");
  });

  it("maps connection and version failures before dispatch", async () => {
    const unavailable = await invoke(async () => {
      throw new CoachClientHandshakeError();
    });
    expect(unavailable.exit).toBe(EXIT_DAEMON_UNAVAILABLE);
    expect(unavailable.terminal).toMatchObject({ error: { code: "DAEMON_UNAVAILABLE" } });
    const mismatch = await invoke(async () => {
      throw new CoachClientVersionMismatchError(4, 3, "client-newer", "service-managed");
    });
    expect(mismatch.exit).toBe(EXIT_VERSION_MISMATCH);
    expect(mismatch.terminal).toMatchObject({ error: { code: "VERSION_MISMATCH" } });
  });

  it("turns malformed progress and a close failure after success into one fixed failure", async () => {
    const malformed = client(result(), { malformedProgress: true });
    const malformedOutcome = await invoke(async () => malformed.value);
    expect(malformedOutcome.exit).toBe(EXIT_AGENT_ERROR);
    expect(malformedOutcome.terminal).toMatchObject({ error: { code: "RUNNER_ERROR" } });
    const closeFailure = client(result(), {
      close: async () => {
        throw new Error("close failed");
      },
    });
    const closeOutcome = await invoke(async () => closeFailure.value);
    expect(closeOutcome.exit).toBe(EXIT_AGENT_ERROR);
    expect(closeOutcome.terminal).toMatchObject({ error: { code: "RUNNER_ERROR" } });
  });
});
