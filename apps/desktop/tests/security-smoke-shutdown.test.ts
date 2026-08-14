import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  SECURITY_SMOKE_SECOND_INSTANCE_FRAME,
  waitForSecuritySmokeShutdown,
  writeSecuritySmokeSecondInstance,
  writeSecuritySmokeShutdownStage,
} from "../src/main/security-smoke-shutdown.js";

describe("security smoke shutdown control", () => {
  it("accepts only one exact fragmented newline-framed command", async () => {
    const input = new PassThrough();
    const accepted = waitForSecuritySmokeShutdown(input);
    input.write("shut");
    input.write("down");
    input.end("\n");
    await expect(accepted).resolves.toBeUndefined();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it.each(["shutdown", "shutdown\nshutdown\n", "shutdown\nextra", "quit\n"])(
    "fails closed for invalid input %#",
    async (frame) => {
      const input = new PassThrough();
      const accepted = waitForSecuritySmokeShutdown(input);
      input.end(frame);
      await expect(accepted).rejects.toThrow(/^security smoke shutdown frame was invalid$/u);
      expect(input.listenerCount("data")).toBe(0);
      expect(input.listenerCount("error")).toBe(0);
      expect(input.listenerCount("end")).toBe(0);
    },
  );

  it("fails immediately when stdin is unavailable", async () => {
    const input = new PassThrough();
    input.destroy();
    await expect(waitForSecuritySmokeShutdown(input)).rejects.toThrow(
      /^security smoke shutdown input was unavailable$/u,
    );
  });

  it("removes input listeners after stream and synchronous failures", async () => {
    const streamError = new PassThrough();
    const streamFailure = waitForSecuritySmokeShutdown(streamError);
    streamError.emit("error", new Error("C:\\private\\input"));
    await expect(streamFailure).rejects.toThrow(/^security smoke shutdown input failed$/u);
    expect(streamError.listenerCount("data")).toBe(0);
    expect(streamError.listenerCount("error")).toBe(0);
    expect(streamError.listenerCount("end")).toBe(0);

    const synchronous = Object.assign(new EventEmitter(), {
      destroyed: false,
      readable: true,
      setEncoding: () => undefined,
      resume: () => {
        throw new Error("C:\\private\\resume");
      },
    });
    await expect(waitForSecuritySmokeShutdown(synchronous as never)).rejects.toThrow(
      /^security smoke shutdown input failed$/u,
    );
    expect(synchronous.listenerCount("data")).toBe(0);
    expect(synchronous.listenerCount("error")).toBe(0);
    expect(synchronous.listenerCount("end")).toBe(0);
  });

  it("emits one fixed newline-framed stage", async () => {
    const output = new PassThrough();
    let source = "";
    output.on("data", (chunk) => {
      source += String(chunk);
    });
    await expect(writeSecuritySmokeShutdownStage(output, "stdin-accepted")).resolves.toBeUndefined();
    expect(source).toBe("DESKTOP_SECURITY_STAGE stdin-accepted\n");
    expect(output.listenerCount("error")).toBe(0);
  });

  it("handles stage callback and synchronous failures without retaining listeners", async () => {
    for (const write of [
      (_chunk: string, callback: (error?: Error | null) => void) =>
        callback(new Error("C:\\private\\callback")),
      () => {
        throw new Error("C:\\private\\write");
      },
    ]) {
      const output = Object.assign(new EventEmitter(), {
        destroyed: false,
        writable: true,
        write,
      });
      await expect(writeSecuritySmokeShutdownStage(output as never, "stdin-accepted")).rejects.toThrow(
        /^security smoke shutdown stage output failed$/u,
      );
      expect(output.listenerCount("error")).toBe(0);
    }
  });

  it("emits the exact second-instance frame and awaits write completion", async () => {
    const output = new PassThrough();
    let source = "";
    output.on("data", (chunk) => {
      source += String(chunk);
    });
    await expect(writeSecuritySmokeSecondInstance(output)).resolves.toBeUndefined();
    expect(source).toBe(SECURITY_SMOKE_SECOND_INSTANCE_FRAME);
    expect(output.listenerCount("error")).toBe(0);
  });

  it("maps second-instance write failures without retaining output listeners", async () => {
    const output = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      write: (_chunk: string, callback: (error?: Error | null) => void) =>
        callback(new Error("C:\\private\\second-instance")),
    });
    await expect(writeSecuritySmokeSecondInstance(output as never)).rejects.toThrow(
      /^security smoke second instance output failed$/u,
    );
    expect(output.listenerCount("error")).toBe(0);
  });
});
