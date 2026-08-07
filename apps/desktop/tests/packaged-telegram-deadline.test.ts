import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  callAcceptanceCdp,
  runAcceptanceCommand,
  terminateAcceptanceChild,
  withAcceptanceDeadline,
} from "./fixtures/packaged-telegram/acceptance-deadline.js";

describe("packaged Telegram acceptance deadlines", () => {
  it("rejects a stalled operation and runs its abort hook", async () => {
    const abort = vi.fn();

    await expect(
      withAcceptanceDeadline("synthetic operation", new Promise(() => undefined), {
        timeoutMs: 20,
        onTimeout: abort,
      }),
    ).rejects.toThrow("synthetic operation timed out");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("clears its timeout after an operation settles", async () => {
    const abort = vi.fn();

    await expect(
      withAcceptanceDeadline("fast operation", Promise.resolve("done"), {
        timeoutMs: 20,
        onTimeout: abort,
      }),
    ).resolves.toBe("done");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    expect(abort).not.toHaveBeenCalled();
  });

  it("terminates a stalled child without exposing its arguments", async () => {
    const sensitiveArgument = "telegram-token-must-not-appear";

    let failure: unknown;
    try {
      await runAcceptanceCommand(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000)",
          sensitiveArgument,
        ],
        { timeoutMs: 500, terminationGraceMs: 20 },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("command timed out");
    expect((failure as Error).message).not.toContain(sensitiveArgument);
  });

  it("does not expose command output or input on failure", async () => {
    const sensitiveValue = "sensitive-command-material";

    let failure: unknown;
    try {
      await runAcceptanceCommand(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(sensitiveValue)}); process.stderr.write(${JSON.stringify(sensitiveValue)}); process.exit(2)`,
        ],
        { input: sensitiveValue },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("command failed");
    expect((failure as Error).message).not.toContain(sensitiveValue);
  });

  it("force-kills a child that ignores graceful termination", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1_000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.stdout?.once("data", () => resolveReady());
    });

    await expect(
      terminateAcceptanceChild(child, { terminationGraceMs: 20, killGraceMs: 500 }),
    ).resolves.toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("closes a stalled debugger connection when its command expires", async () => {
    const close = vi.fn();
    const call = vi.fn(() => new Promise<Record<string, unknown>>(() => undefined));

    await expect(
      callAcceptanceCdp({ socket: { close }, call }, "Runtime.evaluate", {}, 20),
    ).rejects.toThrow("Desktop debugger command timed out");
    expect(close).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("Runtime.evaluate", {});
  });
});
