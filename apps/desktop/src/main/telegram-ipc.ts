import {
  TelegramAllowedSenderRpcParamsSchema,
  TelegramAllowedSendersResultSchema,
  TelegramBotStateSchema,
  TelegramChannelStatusSchema,
  TelegramCredentialSchema,
  TelegramPairingStateSchema,
  type TelegramAllowedSendersResult,
} from "@enduragent/coach-contract";
import type { Clipboard, IpcMain, IpcMainInvokeEvent } from "electron";
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
} from "./constants.js";
import {
  DESKTOP_TELEGRAM_CONTROL_ERROR_CODES,
  type DesktopTelegramChannelStatus,
  type DesktopTelegramControlErrorCode,
  type DesktopTelegramSnapshot,
  type TelegramControlCoordinator,
} from "./telegram-control.js";
import type { TelegramCredentialVault } from "./telegram-credential-vault.js";
import type { DesktopTelegramPowerLifecycle, TelegramGapWarning } from "./telegram-power.js";

const DESKTOP_ERRORS = new Set<string>(DESKTOP_TELEGRAM_CONTROL_ERROR_CODES);
const emptySenders = (): TelegramAllowedSendersResult => ({ senders: [] });

export interface DesktopTelegramStatus extends DesktopTelegramSnapshot {
  readonly gapWarning: TelegramGapWarning;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function copyChannel(value: unknown): DesktopTelegramChannelStatus | undefined {
  const daemon = TelegramChannelStatusSchema.safeParse(value);
  if (daemon.success) return daemon.data;
  if (!record(value)) return undefined;
  if (
    exactKeys(value, ["desiredState", "state"]) &&
    value.desiredState === "enabled" &&
    value.state === "transfer-required"
  ) {
    return { desiredState: "enabled", state: "transfer-required" };
  }
  if (
    exactKeys(value, ["desiredState", "errorCode", "state"]) &&
    (value.desiredState === "disabled" || value.desiredState === "enabled") &&
    value.state === "failed" &&
    typeof value.errorCode === "string" &&
    DESKTOP_ERRORS.has(value.errorCode)
  ) {
    return {
      desiredState: value.desiredState,
      state: "failed",
      errorCode: value.errorCode as DesktopTelegramControlErrorCode,
    };
  }
  return undefined;
}

function copySnapshot(value: unknown): DesktopTelegramSnapshot {
  if (record(value) && exactKeys(value, ["bot", "channel", "credentialConfigured", "pairing"])) {
    const channel = copyChannel(value.channel);
    const bot = TelegramBotStateSchema.safeParse(value.bot);
    const pairing = TelegramPairingStateSchema.safeParse(value.pairing);
    if (
      channel !== undefined &&
      bot.success &&
      pairing.success &&
      typeof value.credentialConfigured === "boolean"
    ) {
      return {
        channel,
        bot: bot.data,
        pairing: pairing.data,
        credentialConfigured: value.credentialConfigured,
      };
    }
  }
  return {
    channel: {
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-control-failed",
    },
    bot: { state: "unconfigured" },
    pairing: { state: "unpaired" },
    credentialConfigured: false,
  };
}

function copySenders(value: unknown): TelegramAllowedSendersResult {
  const parsed = TelegramAllowedSendersResultSchema.safeParse(value);
  return parsed.success ? parsed.data : emptySenders();
}

function copyGapWarning(value: unknown): TelegramGapWarning {
  if (record(value) && exactKeys(value, ["state"]) && value.state === "clear") {
    return { state: "clear" };
  }
  if (
    record(value) &&
    exactKeys(value, ["detectedAt", "state"]) &&
    value.state === "possible-message-loss" &&
    typeof value.detectedAt === "string"
  ) {
    try {
      if (new Date(value.detectedAt).toISOString() === value.detectedAt) {
        return { state: "possible-message-loss", detectedAt: value.detectedAt };
      }
    } catch {}
  }
  return { state: "clear" };
}

function captureClipboard(
  clipboard: Pick<Clipboard, "readText" | "clear">,
): { readonly status: "captured"; readonly token: string } | { readonly status: "failed" } {
  let value: unknown;
  let cleared = false;
  try {
    value = clipboard.readText();
  } catch {
  } finally {
    try {
      clipboard.clear();
      cleared = true;
    } catch {}
  }
  if (typeof value !== "string" || !cleared) return { status: "failed" };
  const parsed = TelegramCredentialSchema.safeParse(value.trim());
  return parsed.success ? { status: "captured", token: parsed.data } : { status: "failed" };
}

export function installDesktopTelegramIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly clipboard: Pick<Clipboard, "readText" | "clear">;
  readonly isTrusted: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly coordinator: TelegramControlCoordinator;
  readonly vault: Pick<TelegramCredentialVault, "credentialStatus">;
  readonly power: Pick<DesktopTelegramPowerLifecycle, "warning" | "acknowledgeWarning">;
}): () => void {
  let operationQueue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const trustedZeroArgument = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    args: readonly unknown[],
  ): void => {
    if (!input.isTrusted(event)) throw new Error("untrusted desktop Telegram request");
    if (args.length !== 0) throw new TypeError("invalid desktop Telegram request");
  };
  const trustedSenderArgument = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    args: readonly unknown[],
  ) => {
    if (!input.isTrusted(event)) throw new Error("untrusted desktop Telegram request");
    if (args.length !== 1) throw new TypeError("invalid desktop Telegram request");
    return TelegramAllowedSenderRpcParamsSchema.parse(args[0]);
  };
  const runSnapshot = (operation: () => Promise<unknown>): Promise<DesktopTelegramStatus> =>
    serialize(async () => {
      try {
        const snapshot = copySnapshot(await operation());
        return { ...snapshot, gapWarning: copyGapWarning(await input.power.warning()) };
      } catch {
        return { ...copySnapshot(undefined), gapWarning: { state: "clear" } };
      }
    });
  const readSenders = (operation: () => Promise<unknown>): Promise<TelegramAllowedSendersResult> =>
    serialize(async () => {
      try {
        return copySenders(await operation());
      } catch {
        return emptySenders();
      }
    });
  const mutateSenders = (
    operation: () => Promise<unknown>,
  ): Promise<TelegramAllowedSendersResult> =>
    serialize(async () => TelegramAllowedSendersResultSchema.parse(await operation()));
  const handlers = [
    [
      DESKTOP_TELEGRAM_STATUS_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.status());
      },
    ],
    [
      DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        const captured = captureClipboard(input.clipboard);
        return runSnapshot(async () => {
          if (captured.status === "failed") return input.coordinator.status();
          const credential = await input.vault.credentialStatus();
          return credential.state === "configured"
            ? input.coordinator.replace(captured.token)
            : input.coordinator.configure(captured.token);
        });
      },
    ],
    [
      DESKTOP_TELEGRAM_ENABLE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.enable());
      },
    ],
    [
      DESKTOP_TELEGRAM_DISABLE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.disable());
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.remove());
      },
    ],
    [
      DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.reconcile());
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.removeWebhook());
      },
    ],
    [
      DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.beginPairing());
      },
    ],
    [
      DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.cancelPairing());
      },
    ],
    [
      DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return readSenders(() => input.coordinator.listAllowedSenders());
      },
    ],
    [
      DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const sender = trustedSenderArgument(event, args);
        return mutateSenders(() => input.coordinator.addAllowedSender(sender));
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const sender = trustedSenderArgument(event, args);
        return mutateSenders(() => input.coordinator.removeAllowedSender(sender));
      },
    ],
    [
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(async () => {
          await input.power.acknowledgeWarning();
          return input.coordinator.status();
        });
      },
    ],
  ] as const;
  for (const [channel, handler] of handlers) input.ipcMain.handle(channel, handler);
  return () => {
    for (const [channel] of handlers) input.ipcMain.removeHandler(channel);
  };
}
