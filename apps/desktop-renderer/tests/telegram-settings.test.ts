import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSettingsController,
  type TelegramControlStatus,
  type TelegramSettingsState,
  type TelegramSettingsView,
} from "../src/settings/telegram-controller.js";

const DISABLED = Object.freeze({
  desiredState: "disabled",
  state: "disabled",
  credentialConfigured: false,
} as const satisfies TelegramControlStatus);

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
        credentialConfigured: true,
      }),
    ),
    enable: vi.fn(
      async (): Promise<TelegramControlStatus> => ({
        ...DISABLED,
        desiredState: "enabled",
        state: "starting",
      }),
    ),
    disable: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
    remove: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
    reconcile: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
  };
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
    expect(runtime.controller.state()).toMatchObject({ status: "ready", channel: DISABLED });

    runtime.bridge.status.mockResolvedValueOnce({
      desiredState: "enabled",
      state: "online",
      credentialConfigured: true,
      botUsername: "synthetic_bot",
    });
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        channel: { state: "online", botUsername: "synthetic_bot" },
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
      channel: { credentialConfigured: true },
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
    resolve({ ...DISABLED, state: "failed" });
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
      .mockResolvedValueOnce({ ...DISABLED, credentialConfigured: true });

    const firstOpen = runtime.controller.activate();
    runtime.controller.close();
    const secondOpen = runtime.controller.activate();
    resolveFirst({ ...DISABLED, state: "failed" });

    await firstOpen;
    await secondOpen;
    expect(runtime.bridge.status).toHaveBeenCalledTimes(2);
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      channel: { credentialConfigured: true },
    });
  });
});
