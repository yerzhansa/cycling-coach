import { describe, expect, it, vi } from "vitest";
import {
  createReleaseNotesController,
  type ReleaseNotesResult,
  type ReleaseNotesView,
} from "../src/release-notes/controller.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function available(overrides: Partial<Extract<ReleaseNotesResult, { status: "available" }>> = {}) {
  return {
    status: "available",
    version: "2026.7.23",
    notes: ["Improved Desktop reliability."],
    releaseUrl: "https://github.com/yerzhansa/enduragent/releases/tag/cycling-coach@2026.7.23",
    ...overrides,
  } as const;
}

function fakeView() {
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onRetry: () => void;
        readonly onClose: () => void;
      }
    | undefined;
  const view: ReleaseNotesView = {
    bind: vi.fn((value) => {
      handlers = value;
    }),
    open: vi.fn(),
    close: vi.fn(),
    renderLoading: vi.fn(),
    renderAvailable: vi.fn(),
    renderUnavailable: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    open: () => handlers?.onOpen(),
    retry: () => handlers?.onRetry(),
    close: () => handlers?.onClose(),
  };
}

describe("release notes controller", () => {
  it("does no startup work, coalesces an active request, and fetches fresh after settlement", async () => {
    const first = deferred<ReleaseNotesResult>();
    const request = vi
      .fn<() => Promise<ReleaseNotesResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(available({ version: "2026.7.24" }));
    const subject = fakeView();
    const controller = createReleaseNotesController({ request, view: subject.view });

    expect(request).not.toHaveBeenCalled();
    const one = controller.activate();
    const two = controller.activate();
    expect(one).toBe(two);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(subject.view.open).toHaveBeenCalledTimes(2);
    expect(subject.view.renderLoading).toHaveBeenCalledOnce();

    first.resolve(available());
    await one;
    expect(subject.view.renderAvailable).toHaveBeenCalledWith(available());

    await controller.activate();
    expect(request).toHaveBeenCalledTimes(2);
    expect(subject.view.renderLoading).toHaveBeenCalledTimes(2);
    expect(subject.view.renderAvailable).toHaveBeenLastCalledWith(
      available({ version: "2026.7.24" }),
    );
  });

  it("renders typed and rejected unavailability without exposing raw errors, then retries", async () => {
    const rawError = new Error("private network detail");
    const request = vi
      .fn<() => Promise<ReleaseNotesResult>>()
      .mockResolvedValueOnce({
        status: "unavailable",
        version: "2026.7.23",
        releaseUrl: "https://github.com/yerzhansa/enduragent/releases",
      })
      .mockRejectedValueOnce(rawError);
    const subject = fakeView();
    createReleaseNotesController({ request, view: subject.view });

    subject.open();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(subject.view.renderUnavailable).toHaveBeenLastCalledWith({
        version: "2026.7.23",
        releaseUrl: "https://github.com/yerzhansa/enduragent/releases",
      }),
    );
    subject.retry();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(subject.view.renderUnavailable).toHaveBeenLastCalledWith({
        version: null,
        releaseUrl: null,
      }),
    );
    expect(JSON.stringify(vi.mocked(subject.view.renderUnavailable).mock.calls)).not.toContain(
      rawError.message,
    );
  });

  it("ignores late settlement and disposes the view exactly once", async () => {
    const gate = deferred<ReleaseNotesResult>();
    const subject = fakeView();
    const controller = createReleaseNotesController({
      request: vi.fn(() => gate.promise),
      view: subject.view,
    });

    const pending = controller.activate();
    await Promise.resolve();
    controller.dispose();
    controller.dispose();
    gate.resolve(available());
    await pending;

    expect(subject.view.renderAvailable).not.toHaveBeenCalled();
    expect(subject.view.renderUnavailable).not.toHaveBeenCalled();
    expect(subject.view.dispose).toHaveBeenCalledOnce();
    await controller.activate();
    expect(subject.view.open).toHaveBeenCalledOnce();
  });
});
