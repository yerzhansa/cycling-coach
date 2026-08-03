import type { TelegramAllowedSendersResult } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
  DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_DISABLE_CHANNEL,
  DESKTOP_TELEGRAM_ENABLE_CHANNEL,
  DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
  DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
  DESKTOP_TELEGRAM_STATUS_CHANNEL,
} from "../src/main/constants.js";
import type {
  DesktopTelegramSnapshot,
  TelegramControlCoordinator,
} from "../src/main/telegram-control.js";
import { installDesktopTelegramIpc } from "../src/main/telegram-ipc.js";
import type { TelegramGapWarning } from "../src/main/telegram-power.js";

const TOKEN = "123456:synthetic-token";
const USERNAME = "desktop_bot";
const PRIMARY_SENDER = {
  senderId: 12345,
  role: "primary",
  addedAt: "2026-08-03T12:00:00.000Z",
} as const;

const snapshot = (
  configured: boolean,
  channel: DesktopTelegramSnapshot["channel"] = {
    desiredState: "disabled",
    state: "disabled",
  },
): DesktopTelegramSnapshot => ({
  channel,
  bot: configured ? { state: "ready", username: USERNAME } : { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: configured,
});

const ipcSnapshot = (configured: boolean, channel?: DesktopTelegramSnapshot["channel"]) => ({
  ...snapshot(configured, channel),
  gapWarning: { state: "clear" } as const,
});

function setup(options: { readonly trusted?: boolean; readonly configured?: boolean } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  const trace: string[] = [];
  let configured = options.configured ?? false;
  const senderList: TelegramAllowedSendersResult = { senders: [PRIMARY_SENDER] };
  const coordinator: TelegramControlCoordinator = {
    status: vi.fn(async () => snapshot(configured)),
    configure: vi.fn(async (token: string) => {
      trace.push(`configure:${token}`);
      configured = true;
      return snapshot(true);
    }),
    replace: vi.fn(async (token: string) => {
      trace.push(`replace:${token}`);
      return snapshot(true);
    }),
    enable: vi.fn(async () => snapshot(true, { desiredState: "enabled", state: "starting" })),
    disable: vi.fn(async () => snapshot(configured)),
    stopPolling: vi.fn(async () => snapshot(configured)),
    remove: vi.fn(async () => {
      configured = false;
      return snapshot(false);
    }),
    reconcile: vi.fn(async () => snapshot(configured)),
    removeWebhook: vi.fn(async () => snapshot(configured)),
    beginPairing: vi.fn(
      async (): Promise<DesktopTelegramSnapshot> => ({
        ...snapshot(true, { desiredState: "enabled", state: "starting" }),
        pairing: {
          state: "awaiting-code",
          code: "ABCDEF",
          expiresAt: "2026-08-03T12:01:00.000Z",
        },
      }),
    ),
    cancelPairing: vi.fn(async () => snapshot(configured)),
    listAllowedSenders: vi.fn(async () => senderList),
    addAllowedSender: vi.fn(async ({ senderId }) => ({
      senders: [...senderList.senders, { senderId, role: "additional" as const }],
    })),
    removeAllowedSender: vi.fn(async () => senderList),
  };
  const vault = {
    credentialStatus: vi.fn(
      async () => ({ state: configured ? "configured" : "missing" }) as const,
    ),
  };
  const clipboard = {
    readText: vi.fn(() => {
      trace.push("read");
      return `  ${TOKEN}  `;
    }),
    clear: vi.fn(() => {
      trace.push("clear");
    }),
  };
  const power = {
    warning: vi.fn(async (): Promise<TelegramGapWarning> => ({ state: "clear" })),
    acknowledgeWarning: vi.fn(async (): Promise<TelegramGapWarning> => ({ state: "clear" })),
  };
  const dispose = installDesktopTelegramIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as never),
      removeHandler: (channel) => removed.push(channel),
    },
    clipboard,
    coordinator,
    vault,
    power,
    isTrusted: () => options.trusted ?? true,
  });
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: {}, senderFrame: {} }, ...args);
  return { clipboard, coordinator, dispose, handlers, invoke, power, removed, trace, vault };
}

describe("Desktop Telegram IPC", () => {
  it("registers exactly thirteen semantic handlers and removes every one", () => {
    const runtime = setup();
    const channels = [
      DESKTOP_TELEGRAM_STATUS_CHANNEL,
      DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
      DESKTOP_TELEGRAM_ENABLE_CHANNEL,
      DESKTOP_TELEGRAM_DISABLE_CHANNEL,
      DESKTOP_TELEGRAM_REMOVE_CHANNEL,
      DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
      DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
      DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
      DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
      DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
      DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
      DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
    ];

    expect(runtime.handlers.size).toBe(13);
    expect([...runtime.handlers.keys()].sort()).toEqual(channels.sort());

    runtime.dispose();
    expect(runtime.removed.sort()).toEqual([...runtime.handlers.keys()].sort());
  });

  it("returns only the strict redacted snapshot shape", async () => {
    const runtime = setup({ configured: true });
    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual(
      ipcSnapshot(true),
    );

    vi.mocked(runtime.coordinator.status).mockResolvedValueOnce({
      ...snapshot(true),
      token: TOKEN,
      exception: "private daemon detail",
    } as never);
    const closed = await runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL);

    expect(closed).toEqual({
      channel: {
        desiredState: "disabled",
        state: "failed",
        errorCode: "telegram-control-failed",
      },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
      credentialConfigured: false,
      gapWarning: { state: "clear" },
    });
    expect(JSON.stringify(closed)).not.toContain(TOKEN);
    expect(JSON.stringify(closed)).not.toContain("private daemon detail");
  });

  it("reads and clears the clipboard synchronously before any credential await", async () => {
    const runtime = setup();

    const pending = runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);
    expect(runtime.trace).toEqual(["read", "clear"]);
    expect(runtime.vault.credentialStatus).not.toHaveBeenCalled();

    await expect(pending).resolves.toEqual(ipcSnapshot(true));
    expect(runtime.trace).toEqual(["read", "clear", `configure:${TOKEN}`]);
    expect(runtime.coordinator.configure).toHaveBeenCalledWith(TOKEN);
    expect(runtime.coordinator.replace).not.toHaveBeenCalled();
  });

  it("selects replacement only after clipboard capture when a credential exists", async () => {
    const runtime = setup({ configured: true });

    await runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);

    expect(runtime.trace).toEqual(["read", "clear", `replace:${TOKEN}`]);
    expect(runtime.coordinator.configure).not.toHaveBeenCalled();
    expect(runtime.coordinator.replace).toHaveBeenCalledWith(TOKEN);
  });

  it("does not use clipboard contents when read, validation, or clear fails", async () => {
    const readFailure = setup();
    readFailure.clipboard.readText.mockImplementationOnce(() => {
      readFailure.trace.push("read-failed");
      throw new Error("private clipboard detail");
    });
    await expect(readFailure.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual(
      ipcSnapshot(false),
    );
    expect(readFailure.clipboard.clear).toHaveBeenCalledOnce();

    const invalid = setup({ configured: true });
    invalid.clipboard.readText.mockReturnValueOnce("invalid token with spaces");
    await expect(invalid.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual(
      ipcSnapshot(true),
    );
    expect(invalid.clipboard.clear).toHaveBeenCalledOnce();

    const clearFailure = setup();
    clearFailure.clipboard.clear.mockImplementationOnce(() => {
      clearFailure.trace.push("clear-failed");
      throw new Error("private clipboard detail");
    });
    await expect(clearFailure.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual(
      ipcSnapshot(false),
    );

    for (const runtime of [readFailure, invalid, clearFailure]) {
      expect(runtime.coordinator.configure).not.toHaveBeenCalled();
      expect(runtime.coordinator.replace).not.toHaveBeenCalled();
    }
  });

  it("exposes webhook removal, pairing, and ordinary controls as zero-argument operations", async () => {
    const runtime = setup({ configured: true });

    await runtime.invoke(DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_ENABLE_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_DISABLE_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_REMOVE_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_RECONCILE_CHANNEL);
    await runtime.invoke(DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL);

    expect(runtime.coordinator.removeWebhook).toHaveBeenCalledWith();
    expect(runtime.coordinator.beginPairing).toHaveBeenCalledWith();
    expect(runtime.coordinator.cancelPairing).toHaveBeenCalledWith();
    expect(runtime.coordinator.enable).toHaveBeenCalledWith();
    expect(runtime.coordinator.disable).toHaveBeenCalledWith();
    expect(runtime.coordinator.remove).toHaveBeenCalledWith();
    expect(runtime.coordinator.reconcile).toHaveBeenCalledWith();
    expect(runtime.power.acknowledgeWarning).toHaveBeenCalledWith();
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL, {})).toThrow(TypeError);
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL, {})).toThrow(
      TypeError,
    );
  });

  it("projects the durable gap warning without exposing additional fields", async () => {
    const runtime = setup({ configured: true });
    runtime.power.warning.mockResolvedValueOnce({
      state: "possible-message-loss",
      detectedAt: "2026-08-03T12:00:00.000Z",
    });

    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      ...snapshot(true),
      gapWarning: {
        state: "possible-message-loss",
        detectedAt: "2026-08-03T12:00:00.000Z",
      },
    });
  });

  it("fails the gap warning closed when its runtime shape is not exact", async () => {
    const runtime = setup({ configured: true });
    runtime.power.warning.mockResolvedValueOnce({
      state: "possible-message-loss",
      detectedAt: "2026-08-03T12:00:00.000Z",
      privateDetail: TOKEN,
    } as never);

    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      ...snapshot(true),
      gapWarning: { state: "clear" },
    });
  });

  it("accepts exactly one strict senderId object for add and remove", async () => {
    const runtime = setup();

    await expect(runtime.invoke(DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL)).resolves.toEqual({
      senders: [PRIMARY_SENDER],
    });
    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({
      senders: [PRIMARY_SENDER, { senderId: 67890, role: "additional" }],
    });
    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({ senders: [PRIMARY_SENDER] });
    expect(runtime.coordinator.addAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });
    expect(runtime.coordinator.removeAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });

    expect(() =>
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, {
        senderId: 67890,
        role: "additional",
      }),
    ).toThrow();
    expect(() =>
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: "67890" }),
    ).toThrow();
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL)).toThrow(TypeError);
    expect(() =>
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }, {}),
    ).toThrow(TypeError);
  });

  it("fails closed on malformed daemon sender lists", async () => {
    const runtime = setup();
    vi.mocked(runtime.coordinator.listAllowedSenders).mockResolvedValueOnce({
      senders: [
        { senderId: 12345, role: "primary" },
        { senderId: 12345, role: "additional" },
      ],
    });

    await expect(runtime.invoke(DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL)).resolves.toEqual({
      senders: [],
    });
  });

  it("rejects a failed allowed-sender removal instead of reporting an empty success", async () => {
    const runtime = setup();
    vi.mocked(runtime.coordinator.removeAllowedSender).mockRejectedValueOnce(
      new Error("daemon unavailable"),
    );

    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).rejects.toThrow("daemon unavailable");
  });

  it("rejects untrusted and malformed calls before clipboard or coordinator access", () => {
    const untrusted = setup({ trusted: false });
    expect(() => untrusted.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).toThrow(
      "untrusted desktop Telegram request",
    );
    expect(() =>
      untrusted.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 12345 }),
    ).toThrow("untrusted desktop Telegram request");

    const extra = setup();
    expect(() => extra.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL, TOKEN)).toThrow(TypeError);
    expect(extra.clipboard.readText).not.toHaveBeenCalled();
    expect(extra.clipboard.clear).not.toHaveBeenCalled();
    expect(extra.coordinator.configure).not.toHaveBeenCalled();
  });
});
