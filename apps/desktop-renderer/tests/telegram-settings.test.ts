import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSettingsController,
  type TelegramAllowedSenders,
  type TelegramControlStatus,
  type TelegramSettingsBridge,
  type TelegramSettingsState,
  type TelegramSettingsView,
} from "../src/settings/telegram-controller.js";

const DISABLED = Object.freeze({
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: false,
  gapWarning: { state: "clear" },
} as const satisfies TelegramControlStatus);

const PAIRED = Object.freeze({
  channel: { desiredState: "enabled", state: "online" },
  bot: { state: "ready", username: "synthetic_bot" },
  pairing: { state: "paired" },
  credentialConfigured: true,
  gapWarning: { state: "clear" },
} as const satisfies TelegramControlStatus);

const SENDERS = Object.freeze({
  senders: Object.freeze([{ senderId: 101, role: "primary" as const }]),
}) satisfies TelegramAllowedSenders;

function setup() {
  const states: TelegramSettingsState[] = [];
  let handlers!: Parameters<TelegramSettingsView["bind"]>[0];
  let poll: (() => void) | undefined;
  const release = vi.fn();
  const bridge = {
    status: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
    pasteTokenFromClipboard: vi.fn(
      async (): Promise<TelegramControlStatus> => ({
        ...DISABLED,
        bot: { state: "ready", username: "synthetic_bot" },
        credentialConfigured: true,
      }),
    ),
    enable: vi.fn(async (): Promise<TelegramControlStatus> => PAIRED),
    disable: vi.fn(
      async (): Promise<TelegramControlStatus> => ({
        ...PAIRED,
        channel: { desiredState: "disabled", state: "disabled" },
      }),
    ),
    remove: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
    reconcile: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
    removeWebhook: vi.fn(
      async (): Promise<TelegramControlStatus> => ({
        ...PAIRED,
        pairing: { state: "unpaired" },
        channel: { desiredState: "disabled", state: "disabled" },
      }),
    ),
    beginPairing: vi.fn(
      async (): Promise<TelegramControlStatus> => ({
        ...PAIRED,
        channel: { desiredState: "enabled", state: "starting" },
        pairing: {
          state: "awaiting-code",
          code: "A1B2C3",
          expiresAt: "1998-07-06T12:01:00.000Z",
        },
      }),
    ),
    cancelPairing: vi.fn(
      async (): Promise<TelegramControlStatus> => ({
        ...PAIRED,
        pairing: { state: "unpaired" },
        channel: { desiredState: "disabled", state: "disabled" },
      }),
    ),
    acknowledgeGapWarning: vi.fn(async (): Promise<TelegramControlStatus> => PAIRED),
    listAllowedSenders: vi.fn(async (): Promise<TelegramAllowedSenders> => SENDERS),
    addAllowedSender: vi.fn(
      async (): Promise<TelegramAllowedSenders> => ({
        senders: [...SENDERS.senders, { senderId: 202, role: "additional" }],
      }),
    ),
    removeAllowedSender: vi.fn(async (): Promise<TelegramAllowedSenders> => SENDERS),
  } satisfies TelegramSettingsBridge;
  const view: TelegramSettingsView = {
    bind: (next) => {
      handlers = next;
    },
    close: vi.fn(),
    render: (state) => states.push(state),
    dispose: vi.fn(),
  };
  const clearInterval = vi.fn();
  const controller = createTelegramSettingsController({
    bridge,
    beginMutation: () => release,
    view,
    pollIntervalMs: 10,
    setInterval: ((callback: () => void) => {
      poll = callback;
      return 17;
    }) as never,
    clearInterval: clearInterval as never,
  });
  return {
    bridge,
    clearInterval,
    controller,
    get handlers() {
      return handlers;
    },
    get poll() {
      return poll;
    },
    release,
    states,
    view,
  };
}

describe("Telegram settings controller", () => {
  it("loads redacted status and polls only while active", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    expect(runtime.controller.state()).toMatchObject({ status: "ready", telegram: DISABLED });

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { channel: { state: "online" } },
        allowedSenders: SENDERS,
      }),
    );

    runtime.controller.close();
    expect(runtime.clearInterval).toHaveBeenCalledWith(17);
    expect(runtime.controller.state()).toEqual({ status: "closed" });
  });

  it("captures a token without an argument and releases the shared mutation lock", async () => {
    const runtime = setup();
    await runtime.controller.activate();

    runtime.handlers.onPasteToken();

    await vi.waitFor(() => expect(runtime.bridge.pasteTokenFromClipboard).toHaveBeenCalledWith());
    await vi.waitFor(() => expect(runtime.release).toHaveBeenCalledOnce());
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { credentialConfigured: true, bot: { username: "synthetic_bot" } },
    });
  });

  it("publishes the short-lived pairing code and manages additional senders", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();

    runtime.handlers.onBeginPairing();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { pairing: { state: "awaiting-code", code: "A1B2C3" } },
      }),
    );

    runtime.handlers.onAddSender(202);
    await vi.waitFor(() => expect(runtime.bridge.addAllowedSender).toHaveBeenCalledWith(202));
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      allowedSenders: { senders: [{ senderId: 101 }, { senderId: 202 }] },
    });
  });

  it("acknowledges the durable delivery-gap warning", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce({
      ...PAIRED,
      gapWarning: {
        state: "possible-message-loss",
        detectedAt: "1998-07-06T12:00:00.000Z",
      },
    });
    await runtime.controller.activate();

    runtime.handlers.onAcknowledgeGapWarning();

    await vi.waitFor(() => expect(runtime.bridge.acknowledgeGapWarning).toHaveBeenCalledWith());
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { gapWarning: { state: "clear" } },
    });
  });

  it("fences a late poll result after close", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    let resolve!: (status: TelegramControlStatus) => void;
    runtime.bridge.status.mockReturnValueOnce(
      new Promise<TelegramControlStatus>((resolveStatus) => {
        resolve = resolveStatus;
      }),
    );
    runtime.poll?.();
    runtime.controller.close();
    resolve(PAIRED);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.controller.state()).toEqual({ status: "closed" });
  });

  it("starts a fresh load when reopened before the previous load settles", async () => {
    const runtime = setup();
    let resolveFirst!: (status: TelegramControlStatus) => void;
    runtime.bridge.status
      .mockReturnValueOnce(
        new Promise<TelegramControlStatus>((resolveStatus) => {
          resolveFirst = resolveStatus;
        }),
      )
      .mockResolvedValueOnce(PAIRED);

    const firstOpen = runtime.controller.activate();
    runtime.controller.close();
    const secondOpen = runtime.controller.activate();
    resolveFirst(DISABLED);

    await firstOpen;
    await secondOpen;
    expect(runtime.bridge.status).toHaveBeenCalledTimes(2);
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { credentialConfigured: true },
    });
  });
});
