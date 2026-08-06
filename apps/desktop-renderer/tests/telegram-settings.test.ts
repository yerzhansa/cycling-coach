import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSettingsController,
  type TelegramAllowedSendersMutationResult,
  type TelegramAllowedSenders,
  type TelegramControlStatus,
  type TelegramMutationResult,
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

const OFFLINE = Object.freeze({
  ...PAIRED,
  channel: { desiredState: "enabled", state: "offline-retrying" },
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
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...DISABLED,
          bot: { state: "ready" as const, username: "synthetic_bot" },
          credentialConfigured: true,
        },
      }),
    ),
    enable: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: PAIRED }),
    ),
    disable: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          channel: { desiredState: "disabled" as const, state: "disabled" as const },
        },
      }),
    ),
    remove: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: DISABLED }),
    ),
    reconcile: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: DISABLED }),
    ),
    removeWebhook: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          pairing: { state: "unpaired" as const },
          channel: { desiredState: "disabled" as const, state: "disabled" as const },
        },
      }),
    ),
    beginPairing: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          channel: { desiredState: "enabled" as const, state: "starting" as const },
          pairing: {
            state: "awaiting-code" as const,
            code: "A1B2C3",
            expiresAt: "1998-07-06T12:01:00.000Z",
          },
        },
      }),
    ),
    cancelPairing: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          pairing: { state: "unpaired" as const },
          channel: { desiredState: "disabled" as const, state: "disabled" as const },
        },
      }),
    ),
    acknowledgeGapWarning: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: PAIRED }),
    ),
    listAllowedSenders: vi.fn(async (): Promise<TelegramAllowedSenders> => SENDERS),
    addAllowedSender: vi.fn(
      async (): Promise<TelegramAllowedSendersMutationResult> => ({
        outcome: "applied",
        current: {
          senders: [...SENDERS.senders, { senderId: 202, role: "additional" }],
        },
      }),
    ),
    removeAllowedSender: vi.fn(
      async (): Promise<TelegramAllowedSendersMutationResult> => ({
        outcome: "applied",
        current: SENDERS,
      }),
    ),
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

  it("shows a sender load failure when a malformed allowed-sender response is rejected", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.bridge.listAllowedSenders.mockRejectedValueOnce(new TypeError());

    await runtime.controller.activate();

    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: PAIRED,
      allowedSenders: null,
      senderLoadFailed: true,
    });
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

  it("gives actionable Keychain recovery when secure storage is unavailable during setup", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "encryption-unavailable",
      current: DISABLED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: DISABLED,
        feedback: {
          tone: "error",
          message:
            "Secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, copy the bot token again, then retry.",
        },
      }),
    );
  });

  it("refuses plaintext token storage without mislabeling it as a Keychain approval problem", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "unsafe-backend",
      current: DISABLED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: DISABLED,
        feedback: {
          tone: "error",
          message:
            "No secure credential backend is available, so Enduragent refused to save the bot token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.",
        },
      }),
    );
    expect(JSON.stringify(runtime.controller.state())).not.toContain("Keychain");
  });

  it("keeps the old bot online while reporting a refused replacement across status polls", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-token",
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { channel: { state: "online" } },
        feedback: {
          tone: "error",
          message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
        },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() => expect(runtime.bridge.status).toHaveBeenCalledTimes(2));
    expect(runtime.controller.state()).toMatchObject({
      telegram: { channel: { state: "online" } },
      feedback: {
        tone: "error",
        message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
      },
    });
  });

  it("announces only real health transitions while preserving action feedback", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(OFFLINE);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-token",
      current: OFFLINE,
    });
    runtime.handlers.onPasteToken();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        feedback: { tone: "error" },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { channel: { state: "online" } },
        healthAnnouncement: "Telegram is online.",
        feedback: {
          tone: "error",
          message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
        },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({ healthAnnouncement: "" }),
    );
    expect(runtime.controller.state()).toMatchObject({ feedback: { tone: "error" } });
  });

  it("reports an uncertain replacement as repair-required without claiming refusal", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { channel: { state: "online" } },
        feedback: {
          tone: "warning",
          message:
            "The copied token was not applied to the running bot because storage could not be verified. Restart Enduragent and check Telegram before trying again.",
        },
      }),
    );
  });

  it("uses neutral copy when replacement completion cannot be confirmed", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { channel: { state: "online" } },
        feedback: {
          tone: "warning",
          message:
            "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
        },
      }),
    );
    expect(JSON.stringify(runtime.controller.state())).not.toContain("was not applied");
  });

  it.each([
    ["clipboard-unavailable", "The clipboard could not be read. No Telegram token was used."],
    [
      "clipboard-clear-failed",
      "The clipboard could not be cleared, so the copied token was not used. The current Telegram bot is unchanged.",
    ],
    [
      "invalid-token-format",
      "The clipboard does not contain a valid Telegram bot token. The current Telegram bot is unchanged.",
    ],
    [
      "validation-unavailable",
      "Telegram could not verify the copied token right now. The current Telegram bot is unchanged.",
    ],
    [
      "webhook-removal-required",
      "The copied bot still uses a webhook. Remove that webhook before replacing the current Telegram bot.",
    ],
    [
      "encryption-unavailable",
      "The current Telegram bot is unchanged because secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, copy the bot token again, then retry.",
    ],
    [
      "unsafe-backend",
      "The current Telegram bot is unchanged because no secure credential backend is available. Enduragent refused to save the copied token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.",
    ],
  ] as const)("reports the closed %s replacement refusal", async (reason, message) => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason,
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: PAIRED,
        feedback: { tone: "error", message },
      }),
    );
  });

  it.each([
    [
      "reconcile" as const,
      "encryption-unavailable" as const,
      "Secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, then choose Check again.",
    ],
    [
      "remove-webhook" as const,
      "unsafe-backend" as const,
      "No secure credential backend is available, so Enduragent refused to read or change the saved bot token without encryption. Quit and reopen Enduragent, then choose Check again.",
    ],
  ])("gives %s an actionable %s recovery", async (action, reason, message) => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    const result = { outcome: "refused", reason, current: PAIRED } as const;
    if (action === "reconcile") {
      runtime.bridge.reconcile.mockResolvedValueOnce(result);
      runtime.handlers.onReconcile();
    } else {
      runtime.bridge.removeWebhook.mockResolvedValueOnce(result);
      runtime.handlers.onRemoveWebhook();
    }

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: PAIRED,
        feedback: { tone: "error", message },
      }),
    );
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

  it("warns that a primary claim may have committed when pairing storage is uncertain", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    runtime.bridge.beginPairing.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: {
        ...PAIRED,
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      },
    });

    runtime.handlers.onBeginPairing();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: {
          pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
        },
        feedback: {
          tone: "warning",
          message:
            "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.",
        },
      }),
    );
  });

  it.each([
    [
      "add",
      "storage-uncertain",
      "The allowed-user list may have changed, but Enduragent could not verify storage. Restart Enduragent and check the list before trying again.",
    ],
    [
      "remove",
      "control-uncertain",
      "The allowed-user list may have changed, but Enduragent lost confirmation from the local coaching service. Restart Enduragent and check the list before trying again.",
    ],
  ] as const)(
    "warns without projecting an untrusted sender list when %s is %s",
    async (operation, reason, message) => {
      const runtime = setup();
      runtime.bridge.status.mockResolvedValueOnce(PAIRED);
      await runtime.controller.activate();
      const previous = runtime.controller.state();
      const mutation =
        operation === "add" ? runtime.bridge.addAllowedSender : runtime.bridge.removeAllowedSender;
      mutation.mockResolvedValueOnce({
        outcome: "uncertain",
        reason,
      });

      if (operation === "add") runtime.handlers.onAddSender(202);
      else runtime.handlers.onRemoveSender(202);

      await vi.waitFor(() =>
        expect(runtime.controller.state()).toMatchObject({
          status: "ready",
          allowedSenders: "allowedSenders" in previous ? previous.allowedSenders : undefined,
          feedback: {
            tone: "warning",
            message,
          },
        }),
      );
      expect(runtime.controller.state()).not.toMatchObject({ status: "error" });
    },
  );

  it("renders a definite sender refusal as an error without replacing the trusted list", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    const previous = runtime.controller.state();
    runtime.bridge.addAllowedSender.mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-state",
    });

    runtime.handlers.onAddSender(202);

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        allowedSenders: "allowedSenders" in previous ? previous.allowedSenders : undefined,
        feedback: {
          tone: "error",
          message: "The allowed-user list could not be changed. Check the user ID and try again.",
        },
      }),
    );
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
