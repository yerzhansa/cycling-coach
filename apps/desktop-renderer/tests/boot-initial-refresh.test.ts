import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_SETUP_SETTLED_REPORT_ATTEMPTS,
  settleInitialSetupStatus,
} from "../src/initial-setup-status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("renderer initial setup settlement", () => {
  it("captures the daemon generation before onboarding and reports only after it settles", async () => {
    const opening = deferred<void>();
    const trace: string[] = [];
    const reportSettled = vi.fn(async (generation: number) => {
      trace.push(`reported:${generation}`);
    });
    settleInitialSetupStatus({
      captureGeneration: async () => {
        trace.push("captured");
        return 7;
      },
      open: () => {
        trace.push("opened");
        return opening.promise;
      },
      markSettled: () => trace.push("settled"),
      reportSettled,
      reportFailure: vi.fn(),
    });

    expect(trace).toEqual(["captured", "opened"]);
    expect(reportSettled).not.toHaveBeenCalled();
    opening.resolve();
    await opening.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(["captured", "opened", "settled", "reported:7"]);
  });

  it("contains a failed settlement transport after onboarding rejects", async () => {
    const opening = deferred<void>();
    const reportFailure = vi.fn();
    const reportSettled = vi.fn(async () => {
      throw new Error("synthetic transport failure");
    });
    settleInitialSetupStatus({
      captureGeneration: async () => 3,
      open: () => opening.promise,
      markSettled: vi.fn(),
      reportSettled,
      reportFailure,
      retryDelay: async () => {},
    });

    opening.reject(new Error("synthetic onboarding failure"));
    await opening.promise.catch(() => {});
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    expect(reportSettled).toHaveBeenCalledTimes(INITIAL_SETUP_SETTLED_REPORT_ATTEMPTS);
  });

  it("retries a transient settlement transport failure until the report lands", async () => {
    const reportFailure = vi.fn();
    const retryDelay = vi.fn(async () => {});
    const reportSettled = vi
      .fn<(generation: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("synthetic transport failure"))
      .mockResolvedValueOnce(undefined);
    settleInitialSetupStatus({
      captureGeneration: async () => 5,
      open: async () => {},
      markSettled: vi.fn(),
      reportSettled,
      reportFailure,
      retryDelay,
    });

    await vi.waitFor(() => expect(reportSettled).toHaveBeenCalledTimes(2));
    expect(reportSettled).toHaveBeenNthCalledWith(2, 5);
    expect(retryDelay).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("observes a failed generation capture while onboarding remains pending", async () => {
    const opening = deferred<void>();
    const capture = deferred<number>();
    const markSettled = vi.fn();
    const reportSettled = vi.fn(async () => {});
    const reportFailure = vi.fn();
    settleInitialSetupStatus({
      captureGeneration: () => capture.promise,
      open: () => opening.promise,
      markSettled,
      reportSettled,
      reportFailure,
    });

    capture.reject(new Error("synthetic generation failure"));
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    expect(markSettled).not.toHaveBeenCalled();
    expect(reportSettled).not.toHaveBeenCalled();

    opening.resolve();
    await opening.promise;
    await vi.waitFor(() => expect(markSettled).toHaveBeenCalledOnce());
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportSettled).not.toHaveBeenCalled();
  });
});
