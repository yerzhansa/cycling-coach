import { describe, expect, it, vi } from "vitest";
import { startNpmTelegramPolling } from "../src/channels/npm-telegram-polling.js";

describe("startNpmTelegramPolling", () => {
  it("forwards a rejected 401 start exactly once", async () => {
    const rejection = { error_code: 401, description: "Unauthorized" };
    const start = vi.fn(async () => {
      throw rejection;
    });
    const reportFatal = vi.fn<(error: unknown) => void>();

    await startNpmTelegramPolling({
      start,
      isShutdownLatched: () => false,
      reportFatal,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(reportFatal).toHaveBeenCalledOnce();
    expect(reportFatal).toHaveBeenCalledWith(rejection);
  });

  it("awaits asynchronous fatal reporting for a rejected 409 start", async () => {
    const rejection = { error_code: 409, description: "Conflict" };
    let markStarted!: () => void;
    const reportingStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishReporting!: () => void;
    const reportingFinished = new Promise<void>((resolve) => {
      finishReporting = resolve;
    });
    const reportFatal = vi.fn(async (error: unknown) => {
      expect(error).toBe(rejection);
      markStarted();
      await reportingFinished;
    });

    const supervised = startNpmTelegramPolling({
      start: async () => {
        throw rejection;
      },
      isShutdownLatched: () => false,
      reportFatal,
    });
    await reportingStarted;

    let settled = false;
    void supervised.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishReporting();
    await supervised;
    expect(reportFatal).toHaveBeenCalledOnce();
  });

  it("forwards a generic rejected start without retrying or classifying it", async () => {
    const rejection = new Error("polling stopped unexpectedly");
    const start = vi.fn(async () => {
      throw rejection;
    });
    const reportFatal = vi.fn<(error: unknown) => void>();

    await startNpmTelegramPolling({
      start,
      isShutdownLatched: () => false,
      reportFatal,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(reportFatal).toHaveBeenCalledOnce();
    expect(reportFatal).toHaveBeenCalledWith(rejection);
  });

  it("suppresses a start rejection when shutdown is latched before rejection", async () => {
    const rejection = new Error("polling aborted by stop");
    let rejectStart!: (error: unknown) => void;
    const startResult = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const start = vi.fn(() => startResult);
    const reportFatal = vi.fn<(error: unknown) => void>();
    let shutdownLatched = false;

    const supervised = startNpmTelegramPolling({
      start,
      isShutdownLatched: () => shutdownLatched,
      reportFatal,
    });
    shutdownLatched = true;
    rejectStart(rejection);

    await expect(supervised).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
    expect(reportFatal).not.toHaveBeenCalled();
  });

  it("completes a resolved start without consulting shutdown or reporting fatal", async () => {
    const start = vi.fn(async () => undefined);
    const isShutdownLatched = vi.fn(() => false);
    const reportFatal = vi.fn<(error: unknown) => void>();

    await expect(
      startNpmTelegramPolling({ start, isShutdownLatched, reportFatal }),
    ).resolves.toBeUndefined();

    expect(start).toHaveBeenCalledOnce();
    expect(isShutdownLatched).not.toHaveBeenCalled();
    expect(reportFatal).not.toHaveBeenCalled();
  });
});
