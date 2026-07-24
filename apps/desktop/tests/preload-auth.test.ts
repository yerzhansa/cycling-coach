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
  deleteCredential(input: unknown): Promise<unknown>;
  retryFailedCredentials(): Promise<unknown>;
  writeCredential(input: unknown): Promise<unknown>;
  llmConfiguration(): Promise<unknown>;
  applyLlmSelection(input: unknown): Promise<unknown>;
  releaseNotes(): Promise<unknown>;
  chatgptStatus(): Promise<unknown>;
  chatgptLogin(input: unknown): Promise<unknown>;
  getUpdateState(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  restartToUpdate(): Promise<unknown>;
  onUpdateState(listener: (state: unknown) => void): () => void;
}

const chatGptSelection = {
  provider: "openai-codex",
  model: "gpt-5.5",
  endpoint: { mode: "automatic" },
} as const;

const providerOrder = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
] as const;

const defaultEndpointProviders = new Set([
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
]);

function llmConfiguration() {
  return {
    schemaVersion: 1,
    providers: providerOrder.map((provider) => {
      const defaultModel = `${provider}-default`;
      return {
        provider,
        defaultModel,
        models: [{ value: defaultModel, label: `${provider} default` }],
        ...(defaultEndpointProviders.has(provider)
          ? { defaultBaseUrl: `https://${provider}.example.invalid/v1` }
          : {}),
      };
    }),
    active: { provider: "anthropic", model: "athlete-custom-model" },
  };
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
    expect(Object.keys(bridge).sort()).toEqual(
      [
        "applyLlmSelection",
        "chatgptLogin",
        "chatgptStatus",
        "chooseImportFiles",
        "credentialStatuses",
        "deleteCredential",
        "getUpdateState",
        "getDaemonConnection",
        "llmConfiguration",
        "checkForUpdates",
        "onDroppedImportFiles",
        "onUpdateState",
        "releaseNotes",
        "restartToUpdate",
        "retryFailedCredentials",
        "writeCredential",
      ].sort(),
    );
    expect(bridge).not.toHaveProperty("openExternal");
  });

  it("returns strict copied update states from zero-argument channels", async () => {
    const downloaded = { status: "downloaded", version: "2026.7.23" };
    mocks.invoke
      .mockResolvedValueOnce({ status: "idle" })
      .mockResolvedValueOnce(downloaded)
      .mockResolvedValueOnce({ status: "installing", version: "2026.7.23" });

    await expect(bridge.getUpdateState()).resolves.toEqual({ status: "idle" });
    const copy = await bridge.checkForUpdates();
    expect(copy).toEqual(downloaded);
    expect(copy).not.toBe(downloaded);
    await expect(bridge.restartToUpdate()).resolves.toEqual({
      status: "installing",
      version: "2026.7.23",
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:update:get"],
      ["desktop:update:check"],
      ["desktop:update:restart"],
    ]);
  });

  it("forwards only strict update events and supports idempotent listener disposal", () => {
    const listener = vi.fn();
    const dispose = bridge.onUpdateState(listener);
    const onState = mocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:update:state",
    )?.[1] as (_event: unknown, value: unknown) => void;
    onState(undefined, { status: "downloaded", version: "2026.7.23" });
    onState(undefined, {
      status: "downloaded",
      version: "2026.7.23",
      downloadedFile: "/private/update.zip",
    });
    onState(undefined, { status: "failed", stage: "install" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      status: "downloaded",
      version: "2026.7.23",
    });
    dispose();
    dispose();
    onState(undefined, { status: "current" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects malformed update state unions without exposing raw fields", async () => {
    for (const value of [
      null,
      { status: "idle", extra: true },
      { status: "downloading", version: "2026.7.23-beta.1" },
      { status: "downloaded", version: " 2026.7.23" },
      { status: "failed", stage: "install" },
      { status: "failed", stage: "check", error: "Authorization: secret" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.getUpdateState()).rejects.toBeInstanceOf(TypeError);
    }
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

  it("validates and copies deletion metadata without accepting widened shapes", async () => {
    const result = {
      credential: "anthropic",
      status: "deleted",
      cleanupPending: false,
    };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = await bridge.deleteCredential({ credential: "anthropic" });

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:settings:credential-delete", {
      credential: "anthropic",
    });

    for (const input of [
      { credential: "unknown" },
      { credential: "anthropic", extra: true },
      "anthropic",
    ]) {
      await expect(bridge.deleteCredential(input)).rejects.toBeInstanceOf(TypeError);
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    mocks.invoke.mockResolvedValueOnce({
      credential: "anthropic",
      status: "deleted",
      cleanupPending: false,
      extra: true,
    });
    await expect(bridge.deleteCredential({ credential: "anthropic" })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("copies the bounded model catalogue and active selection from its private channel", async () => {
    const configuration = llmConfiguration();
    mocks.invoke.mockResolvedValueOnce(configuration);

    const copied = (await bridge.llmConfiguration()) as typeof configuration;

    expect(copied).toEqual(configuration);
    expect(copied).not.toBe(configuration);
    expect(copied.providers).not.toBe(configuration.providers);
    expect(copied.providers[0]?.models).not.toBe(configuration.providers[0]?.models);
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:onboarding:llm-configuration");
  });

  it("normalizes strict selections and credential writes before invoking main", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true })
      .mockResolvedValueOnce({
        slot: "openrouter",
        status: "configured",
        runtimeReady: true,
      });
    const selection = {
      provider: "openrouter",
      model: "  athlete-model  ",
      endpoint: { mode: "custom", value: "  https://models.example.invalid/v1  " },
    };

    await expect(bridge.applyLlmSelection(selection)).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    await expect(
      bridge.writeCredential({
        slot: "openrouter",
        value: "obviously-fake-key",
        selection,
      }),
    ).resolves.toMatchObject({ status: "configured" });
    const normalized = {
      provider: "openrouter",
      model: "athlete-model",
      endpoint: { mode: "custom", value: "https://models.example.invalid/v1" },
    };
    expect(mocks.invoke.mock.calls).toEqual([
      ["enduragent:onboarding:llm-selection-apply", normalized],
      [
        "enduragent:onboarding:credential-write",
        { slot: "openrouter", value: "obviously-fake-key", selection: normalized },
      ],
    ]);
  });

  it("accepts a securely stored inactive credential result", async () => {
    mocks.invoke.mockResolvedValueOnce({
      slot: "anthropic",
      status: "configured",
      runtimeReady: false,
    });

    await expect(
      bridge.writeCredential({
        slot: "anthropic",
        value: "obviously-fake-key",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: false,
    });
  });

  it("rejects malformed model and endpoint inputs before IPC", async () => {
    const malformed = [
      { provider: "anthropic", model: "", endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "x".repeat(513), endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "bad\u0000model", endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "\tmodel", endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "model", endpoint: { mode: "default" } },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "http://models.example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://user:secret@example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1?secret=value" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1#" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1#secret" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: `https://example.invalid/${"x".repeat(4_096)}` },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "automatic", extra: true },
      },
    ];

    for (const selection of malformed) {
      await expect(bridge.applyLlmSelection(selection)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      bridge.writeCredential({
        slot: "anthropic",
        value: "obviously-fake-key",
        selection: {
          provider: "openrouter",
          model: "model",
          endpoint: { mode: "automatic" },
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      bridge.chatgptLogin({
        provider: "anthropic",
        model: "model",
        endpoint: { mode: "automatic" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed privileged model responses without exposing extra fields", async () => {
    const configuration = llmConfiguration();
    const malformed = [
      { ...configuration, secret: "private" },
      {
        ...configuration,
        providers: configuration.providers.map((provider, index) =>
          index === 0 ? { ...provider, rawBaseUrl: "https://private.invalid" } : provider,
        ),
      },
      {
        ...configuration,
        providers: configuration.providers.map((provider, index) =>
          index === 0 ? { ...provider, defaultModel: "not-in-models" } : provider,
        ),
      },
      { ...configuration, active: { ...configuration.active, apiKey: "private" } },
    ];
    for (const value of malformed) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.llmConfiguration()).rejects.toBeInstanceOf(TypeError);
    }
    for (const value of [
      { status: "configured", runtimeReady: true, raw: "private" },
      { status: "refused", reason: "storage-failed" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(
        bridge.applyLlmSelection({
          provider: "anthropic",
          model: "model",
          endpoint: { mode: "automatic" },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("exposes strict status and configured results", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
    await expect(bridge.chatgptStatus()).resolves.toEqual({
      state: "configured",
      runtimeReady: false,
    });
    await expect(bridge.chatgptLogin(chatGptSelection)).resolves.toEqual({
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
    await expect(bridge.chatgptLogin(chatGptSelection)).resolves.toEqual({
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
        : bridge.chatgptLogin(chatGptSelection);
      await expect(operation).rejects.toBeInstanceOf(TypeError);
    }
  });
});
