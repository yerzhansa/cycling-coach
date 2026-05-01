import { describe, it, expect, vi } from "vitest";
import { runStartupHook } from "../src/run-binary.js";
import type { Memory } from "../src/memory/store.js";

// Memory is opaque to runStartupHook — it just passes the reference through.
// A bare object is sufficient as a stand-in identity to assert on.
const stubMemory = {} as Memory;

describe("runStartupHook", () => {
  it("does nothing when no hook is provided", async () => {
    await expect(runStartupHook(stubMemory, undefined)).resolves.toBeUndefined();
  });

  it("invokes the hook with the memory argument", async () => {
    const hook = vi.fn();
    await runStartupHook(stubMemory, hook);
    expect(hook).toHaveBeenCalledWith(stubMemory);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("awaits an async hook before returning", async () => {
    let resolved = false;
    const hook = async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    };
    await runStartupHook(stubMemory, hook);
    expect(resolved).toBe(true);
  });

  it("logs a warning and continues if the hook throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(runStartupHook(stubMemory, hook)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Continuing"));
    warnSpy.mockRestore();
  });

  it("handles non-Error throws gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = vi.fn().mockRejectedValue("string error");
    await expect(runStartupHook(stubMemory, hook)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("string error"));
    warnSpy.mockRestore();
  });
});
