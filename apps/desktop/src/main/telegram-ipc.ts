import type { Clipboard, IpcMain, IpcMainInvokeEvent } from "electron";
import { TelegramCredentialSchema } from "@enduragent/coach-contract";
import {
  DESKTOP_TELEGRAM_DISABLE_CHANNEL,
  DESKTOP_TELEGRAM_ENABLE_CHANNEL,
  DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_CHANNEL,
  DESKTOP_TELEGRAM_STATUS_CHANNEL,
} from "./constants.js";
import type { TelegramCredentialVault } from "./telegram-credential-vault.js";
import {
  TELEGRAM_CONTROL_ERROR_CODES,
  TELEGRAM_CONTROL_STATES,
  type TelegramControlCoordinator,
  type TelegramControlErrorCode,
  type TelegramControlState,
  type TelegramControlStatus,
  type TelegramDesiredControlState,
} from "./telegram-control.js";

export interface DesktopTelegramStatus extends TelegramControlStatus {
  readonly credentialConfigured: boolean;
}

const STATES = new Set<string>(TELEGRAM_CONTROL_STATES);
const ERROR_CODES = new Set<string>(TELEGRAM_CONTROL_ERROR_CODES);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function failure(desiredState: TelegramDesiredControlState = "disabled"): TelegramControlStatus {
  return {
    desiredState,
    state: "failed",
    errorCode: "telegram-control-failed",
  };
}

function copyStatus(value: unknown): TelegramControlStatus {
  if (
    !record(value) ||
    (value.desiredState !== "disabled" && value.desiredState !== "enabled") ||
    typeof value.state !== "string" ||
    !STATES.has(value.state)
  ) {
    return failure();
  }
  const status: {
    desiredState: TelegramDesiredControlState;
    state: TelegramControlState;
    botUsername?: string;
    since?: string;
    lastSuccessfulPollAt?: string;
    retryCount?: number;
    errorCode?: TelegramControlErrorCode;
  } = {
    desiredState: value.desiredState,
    state: value.state as TelegramControlState,
  };
  if (
    typeof value.botUsername === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value.botUsername)
  ) {
    status.botUsername = value.botUsername;
  }
  if (canonicalTimestamp(value.since)) status.since = value.since;
  if (canonicalTimestamp(value.lastSuccessfulPollAt)) {
    status.lastSuccessfulPollAt = value.lastSuccessfulPollAt;
  }
  if (
    Number.isSafeInteger(value.retryCount) &&
    (value.retryCount as number) >= 0 &&
    (value.retryCount as number) <= 1_000_000
  ) {
    status.retryCount = value.retryCount as number;
  }
  if (typeof value.errorCode === "string" && ERROR_CODES.has(value.errorCode)) {
    status.errorCode = value.errorCode as TelegramControlErrorCode;
  }
  return status;
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
  const project = async (status: unknown): Promise<DesktopTelegramStatus> => {
    let credentialConfigured = false;
    try {
      credentialConfigured = (await input.vault.credentialStatus()).state === "configured";
    } catch {}
    return { ...copyStatus(status), credentialConfigured };
  };
  const run = (operation: () => Promise<unknown>): Promise<DesktopTelegramStatus> =>
    serialize(async () => {
      try {
        return await project(await operation());
      } catch {
        return project(failure());
      }
    });
  const handlers = [
    [
      DESKTOP_TELEGRAM_STATUS_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return run(() => input.coordinator.status());
      },
    ],
    [
      DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        const captured = captureClipboard(input.clipboard);
        return run(async () => {
          if (captured.status === "failed") return failure();
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
        return run(() => input.coordinator.enable());
      },
    ],
    [
      DESKTOP_TELEGRAM_DISABLE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return run(() => input.coordinator.disable());
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return run(() => input.coordinator.remove());
      },
    ],
    [
      DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return run(() => input.coordinator.reconcile());
      },
    ],
  ] as const;
  for (const [channel, handler] of handlers) input.ipcMain.handle(channel, handler);
  return () => {
    for (const [channel] of handlers) input.ipcMain.removeHandler(channel);
  };
}
