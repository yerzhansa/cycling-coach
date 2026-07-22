import { extname, isAbsolute } from "node:path";
import type { ConfigureRuntimeRpcParams, LlmProvider } from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type { ChatGptAuthController } from "./chatgpt-auth.js";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  type CredentialSlotStatus,
  type CredentialVault,
  type CredentialWriteResult,
  type DesktopCredentialSlot,
} from "./credential-vault.js";

export const DESKTOP_CREDENTIAL_STATUS_CHANNEL = "enduragent:onboarding:credential-status" as const;
export const DESKTOP_CREDENTIAL_RETRY_CHANNEL = "enduragent:onboarding:credential-retry" as const;
export const DESKTOP_CREDENTIAL_WRITE_CHANNEL = "enduragent:onboarding:credential-write" as const;
export const DESKTOP_CHATGPT_STATUS_CHANNEL = "enduragent:onboarding:chatgpt-status" as const;
export const DESKTOP_CHATGPT_LOGIN_CHANNEL = "enduragent:onboarding:chatgpt-login" as const;
export const DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL =
  "enduragent:onboarding:choose-import-files" as const;

export interface OnboardingDialogPort {
  showOpenDialog(
    window: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

interface RegisterOnboardingIpcOptions {
  readonly ipcMain: IpcMain;
  readonly dialog: OnboardingDialogPort;
  readonly window: BrowserWindow;
  readonly vault: CredentialVault;
  readonly chatGptAuth: ChatGptAuthController;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly checkIntervalsCredentialOwner: (
    value: string,
  ) => Promise<"unowned" | "matched" | "mismatch" | "unresolved" | "store-unavailable">;
}

const SUPPORTED_EXTENSIONS = new Set([".fit", ".tcx", ".gpx"]);

export function runtimeConfigurationForCredential(
  slot: DesktopCredentialSlot,
  value: string,
): ConfigureRuntimeRpcParams {
  if (slot === "intervals-icu") {
    return { intervals: { api_key: value } };
  }
  return {
    llm: {
      provider: slot satisfies LlmProvider,
      api_key: value,
    },
  };
}

function isSlot(value: unknown): value is DesktopCredentialSlot {
  return (
    typeof value === "string" && (DESKTOP_CREDENTIAL_SLOTS as readonly string[]).includes(value)
  );
}

function parseWriteInput(value: unknown): {
  readonly slot: DesktopCredentialSlot;
  readonly value: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "slot") ||
    !Object.hasOwn(input, "value") ||
    !isSlot(input.slot) ||
    typeof input.value !== "string"
  ) {
    throw new TypeError();
  }
  return { slot: input.slot, value: input.value };
}

function minimizeStatuses(value: readonly CredentialSlotStatus[]): readonly CredentialSlotStatus[] {
  return value.map((entry) => ({
    slot: entry.slot,
    state: entry.state,
    runtimeState: entry.runtimeState,
  }));
}

function minimizeWrite(value: CredentialWriteResult): CredentialWriteResult {
  if (value.status === "configured") {
    return { slot: value.slot, status: "configured", runtimeReady: true };
  }
  return { slot: value.slot, status: "refused", reason: value.reason };
}

export function registerOnboardingIpc(options: RegisterOnboardingIpcOptions): () => void {
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!options.isTrusted(event)) throw new TypeError();
  };
  options.ipcMain.handle(DESKTOP_CREDENTIAL_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    try {
      await options.vault.reapplyConfigured();
      return minimizeStatuses(await options.vault.credentialStatuses());
    } catch {
      return DESKTOP_CREDENTIAL_SLOTS.map((slot) => ({
        slot,
        state: "re-prompt" as const,
        runtimeState: null,
      }));
    }
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_RETRY_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    await options.vault.retryFailed();
    return minimizeStatuses(await options.vault.credentialStatuses());
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_WRITE_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const input = parseWriteInput(args[0]);
    try {
      if (input.slot === "intervals-icu") {
        const ownership = await options
          .checkIntervalsCredentialOwner(input.value)
          .catch(() => "check-unavailable" as const);
        if (ownership === "mismatch") {
          return {
            slot: input.slot,
            status: "refused",
            reason: "training-account-mismatch",
          };
        }
      }
      return minimizeWrite(await options.vault.writeCredential(input));
    } catch {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    }
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return options.chatGptAuth.status();
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_LOGIN_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return options.chatGptAuth.login();
  });
  options.ipcMain.handle(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    let result: Awaited<ReturnType<OnboardingDialogPort["showOpenDialog"]>>;
    try {
      result = await options.dialog.showOpenDialog(options.window, {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Ride files", extensions: ["fit", "tcx", "gpx"] }],
      });
    } catch {
      return [];
    }
    if (result.canceled) return [];
    return result.filePaths.filter(
      (path) =>
        typeof path === "string" &&
        path.length <= 4_096 &&
        isAbsolute(path) &&
        SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()),
    );
  });
  return () => {
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_RETRY_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_WRITE_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_LOGIN_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL);
  };
}
