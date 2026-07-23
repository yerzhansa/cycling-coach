import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {};
  class FakeAnchor {
    constructor(
      readonly href: string,
      readonly target = "_blank",
    ) {}
  }
  let clickListener: ((event: Record<string, unknown>) => void) | undefined;
  const fakeWindow = {
    addEventListener: vi.fn((name: string, listener: typeof clickListener) => {
      if (name === "click") clickListener = listener;
    }),
    dispatchEvent: vi.fn(),
  };
  return {
    exposed,
    FakeAnchor,
    fakeWindow,
    get clickListener() {
      return clickListener;
    },
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      exposed[name] = value;
    }),
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, send: mocks.send },
  webUtils: { getPathForFile: vi.fn() },
}));

interface AuthBridge {
  getDaemonConnection(failedGeneration?: number): Promise<unknown>;
  credentialStatuses(): Promise<unknown>;
  retryFailedCredentials(): Promise<unknown>;
  releaseNotes(): Promise<unknown>;
  chatgptStatus(): Promise<unknown>;
  chatgptLogin(): Promise<unknown>;
}

let bridge: AuthBridge;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: mocks.fakeWindow,
    HTMLAnchorElement: mocks.FakeAnchor,
  });
  await import("../src/preload/index.js");
  bridge = mocks.exposed.enduragentAuth as AuthBridge;
});

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.send.mockReset();
  mocks.fakeWindow.dispatchEvent.mockReset();
  Object.assign(globalThis, {
    window: mocks.fakeWindow,
    HTMLAnchorElement: mocks.FakeAnchor,
  });
});

describe("desktop preload ChatGPT auth", () => {
  it("reuses the connection channel with a closed recovery request", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await bridge.getDaemonConnection();
    await bridge.getDaemonConnection(7);
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:get-daemon-connection"],
      ["desktop:get-daemon-connection", { generation: 7 }],
    ]);
  });

  it("forwards only closed lifecycle states to the renderer", () => {
    const listener = mocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:daemon-lifecycle",
    )?.[1] as (_event: unknown, value: unknown) => void;
    listener(undefined, { status: "recovering", generation: 2 });
    listener(undefined, { status: "recovering", generation: 0 });
    expect(mocks.fakeWindow.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(mocks.fakeWindow.dispatchEvent.mock.calls[0]![0]).toMatchObject({
      type: "enduragent-lifecycle",
      detail: { status: "recovering", generation: 2 },
    });
  });

  it("keeps the external-link sender private while preserving the exact public bridge", () => {
    expect(Object.keys(mocks.exposed)).toEqual(["enduragentAuth"]);
    expect(Object.keys(bridge).sort()).toEqual([
      "chatgptLogin",
      "chatgptStatus",
      "chooseImportFiles",
      "credentialStatuses",
      "getDaemonConnection",
      "onDroppedImportFiles",
      "releaseNotes",
      "retryFailedCredentials",
      "writeCredential",
    ]);
    expect(bridge).not.toHaveProperty("openExternal");
  });

  it("returns closed copied release note results from the zero-argument channel", async () => {
    const notes = ["Added release notes to the desktop."];
    const available = {
      status: "available",
      version: "2026.7.23",
      notes,
      releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    };
    mocks.invoke.mockResolvedValueOnce(available).mockResolvedValueOnce({
      status: "unavailable",
      version: null,
      releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
    });

    const availableCopy = (await bridge.releaseNotes()) as typeof available;
    expect(availableCopy).toEqual(available);
    expect(availableCopy).not.toBe(available);
    expect(availableCopy.notes).not.toBe(notes);
    await expect(bridge.releaseNotes()).resolves.toEqual({
      status: "unavailable",
      version: null,
      releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:get-release-notes"],
      ["desktop:get-release-notes"],
    ]);
  });

  it("accepts a known unavailable version with only a canonical tag URL", async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: "unavailable",
      version: "2026.7.23",
      releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    });

    await expect(bridge.releaseNotes()).resolves.toEqual({
      status: "unavailable",
      version: "2026.7.23",
      releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    });
  });

  it("rejects malformed release note unions, strings, counts, and totals", async () => {
    const tagUrl =
      "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23";
    const malformed = [
      null,
      {
        status: "available",
        version: "2026.7.23",
        notes: [],
        releaseUrl: tagUrl,
        extra: true,
      },
      {
        status: "unavailable",
        version: null,
        notes: [],
        releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
      },
      {
        status: "available",
        version: `v${"1".repeat(64)}`,
        notes: [],
        releaseUrl: tagUrl,
      },
      {
        status: "available",
        version: " 2026.7.23",
        notes: [],
        releaseUrl: tagUrl,
      },
      {
        status: "available",
        version: "latest",
        notes: [],
        releaseUrl: tagUrl,
      },
      {
        status: "available",
        version: "2026.7.23",
        notes: ["unsafe\u0000note"],
        releaseUrl: tagUrl,
      },
      {
        status: "available",
        version: "2026.7.23",
        notes: Array.from({ length: 101 }, () => "note"),
        releaseUrl: tagUrl,
      },
      {
        status: "available",
        version: "2026.7.23",
        notes: ["x".repeat(2_001)],
        releaseUrl: tagUrl,
      },
      {
        status: "available",
        version: "2026.7.23",
        notes: Array.from({ length: 33 }, () => "x".repeat(2_000)),
        releaseUrl: tagUrl,
      },
    ];

    for (const value of malformed) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.releaseNotes()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("requires release URLs to match the result version exactly", async () => {
    const values = [
      {
        status: "available",
        version: "2026.7.23",
        notes: [],
        releaseUrl:
          "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.22",
      },
      {
        status: "unavailable",
        version: "2026.7.23",
        releaseUrl: "https://github.com/yerzhansa/cycling-coach/releases",
      },
      {
        status: "unavailable",
        version: null,
        releaseUrl:
          "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
      },
    ];

    for (const value of values) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.releaseNotes()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it.each([
    "http://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    "https://user:secret@github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    "https://github.com:444/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    "https://github.com/other/cycling-coach/releases/tag/cycling-coach@2026.7.23",
    "https://github.com/yerzhansa/cycling-coach/releases/latest",
    "https://github.com/yerzhansa/cycling-coach/releases/tag/",
    "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23?token=secret",
    "https://github.com/yerzhansa/cycling-coach/releases/tag/cycling-coach@2026.7.23#notes",
  ])("rejects a noncanonical or out-of-repository release URL: %s", async (releaseUrl) => {
    mocks.invoke.mockResolvedValueOnce({
      status: "available",
      version: "2026.7.23",
      notes: [],
      releaseUrl,
    });

    await expect(bridge.releaseNotes()).rejects.toBeInstanceOf(TypeError);
  });

  it("sends a nested trusted target-blank anchor activation over the private channel", () => {
    const anchor = new mocks.FakeAnchor("https://example.test/guide");
    const preventDefault = vi.fn();

    mocks.clickListener?.({
      isTrusted: true,
      defaultPrevented: false,
      button: 0,
      composedPath: () => [{}, anchor],
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith("desktop:open-external", "https://example.test/guide");
    expect(mocks.fakeWindow.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      true,
    );
  });

  it("ignores synthetic, handled, non-primary, non-anchor, and non-blank clicks", () => {
    const preventDefault = vi.fn();
    const cases = [
      {
        isTrusted: false,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/")],
      },
      {
        isTrusted: true,
        defaultPrevented: true,
        button: 0,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/")],
      },
      {
        isTrusted: true,
        defaultPrevented: false,
        button: 1,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/")],
      },
      {
        isTrusted: true,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [{}],
      },
      {
        isTrusted: true,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/", "_self")],
      },
    ];
    for (const event of cases) mocks.clickListener?.({ ...event, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("exposes closed credential runtime states and the retry command", async () => {
    const statuses = [
      { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
      { slot: "openrouter", state: "configured", runtimeState: "failed" },
      { slot: "openai", state: "configured", runtimeState: "active" },
      { slot: "google", state: "missing", runtimeState: null },
      { slot: "deepseek", state: "missing", runtimeState: null },
      { slot: "qwen", state: "missing", runtimeState: null },
      { slot: "minimax", state: "missing", runtimeState: null },
      { slot: "kimi", state: "missing", runtimeState: null },
      { slot: "zai", state: "missing", runtimeState: null },
      { slot: "intervals-icu", state: "missing", runtimeState: null },
    ];
    mocks.invoke.mockResolvedValueOnce(statuses).mockResolvedValueOnce(statuses);

    await expect(bridge.credentialStatuses()).resolves.toEqual(statuses);
    await expect(bridge.retryFailedCredentials()).resolves.toEqual(statuses);
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "enduragent:onboarding:credential-status",
      "enduragent:onboarding:credential-retry",
    ]);
  });

  it("exposes strict status and configured results", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
    await expect(bridge.chatgptStatus()).resolves.toEqual({
      state: "configured",
      runtimeReady: false,
    });
    await expect(bridge.chatgptLogin()).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "enduragent:onboarding:chatgpt-status",
      "enduragent:onboarding:chatgpt-login",
    ]);
  });

  it("accepts only closed refusal reasons and exact keys", async () => {
    mocks.invoke.mockResolvedValueOnce({ status: "refused", reason: "timed-out" });
    await expect(bridge.chatgptLogin()).resolves.toEqual({
      status: "refused",
      reason: "timed-out",
    });
    for (const value of [
      { state: "configured", runtimeReady: true, extra: true },
      { state: "unknown", runtimeReady: false },
      { status: "refused", reason: "unknown" },
      { status: "configured", runtimeReady: false },
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      const operation = Object.hasOwn(value, "state")
        ? bridge.chatgptStatus()
        : bridge.chatgptLogin();
      await expect(operation).rejects.toBeInstanceOf(TypeError);
    }
  });
});
