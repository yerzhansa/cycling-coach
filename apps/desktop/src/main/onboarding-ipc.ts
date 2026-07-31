import { extname, isAbsolute } from "node:path";
import type {
  ConfigureRuntimeRpcParams,
  LlmProvider,
  RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import {
  CHATGPT_PROFILE_NAME,
  type ChatGptAuthController,
  type ChatGptLoginResult,
  type ChatGptStatus,
} from "./chatgpt-auth.js";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  type CredentialSlotStatus,
  type CredentialDeleteResult,
  type CredentialVault,
  type CredentialWriteResult,
  type DesktopCredentialSlot,
} from "./credential-vault.js";
import {
  parseChatGptLlmSelection,
  parseOnboardingLlmSelection,
  publicLlmProviderConfiguration,
  runtimeConfigurationForSelection,
  type OnboardingLlmConfiguration,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";

export const DESKTOP_CREDENTIAL_STATUS_CHANNEL = "enduragent:onboarding:credential-status" as const;
export const DESKTOP_CREDENTIAL_RETRY_CHANNEL = "enduragent:onboarding:credential-retry" as const;
export const DESKTOP_CREDENTIAL_WRITE_CHANNEL = "enduragent:onboarding:credential-write" as const;
export const DESKTOP_CREDENTIAL_DELETE_CHANNEL = "enduragent:settings:credential-delete" as const;
export const DESKTOP_LLM_CONFIGURATION_CHANNEL = "enduragent:onboarding:llm-configuration" as const;
export const DESKTOP_LLM_SELECTION_APPLY_CHANNEL =
  "enduragent:onboarding:llm-selection-apply" as const;
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
  readonly getRuntimeConfig: () => Promise<RuntimeConfigSnapshot>;
  readonly applyExistingLlmSelection: (selection: OnboardingLlmSelection) => Promise<boolean>;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly checkIntervalsCredentialOwner: (
    value: string,
  ) => Promise<"unowned" | "matched" | "mismatch" | "unresolved" | "store-unavailable">;
}

const SUPPORTED_EXTENSIONS = new Set([".fit", ".tcx", ".gpx"]);

export function runtimeConfigurationForCredential(
  slot: DesktopCredentialSlot,
  value: string,
  selection?: OnboardingLlmSelection,
): ConfigureRuntimeRpcParams {
  if (slot === "intervals-icu") {
    if (selection !== undefined) throw new TypeError();
    return { intervals: { api_key: value } };
  }
  if (selection !== undefined) {
    const parsed = parseOnboardingLlmSelection(selection);
    if (parsed.provider !== slot) throw new TypeError();
    return runtimeConfigurationForSelection(parsed, value);
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
  readonly selection?: OnboardingLlmSelection;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const input = value as Record<string, unknown>;
  const hasSelection = Object.hasOwn(input, "selection");
  if (
    Object.keys(input).length !== (hasSelection ? 3 : 2) ||
    !Object.hasOwn(input, "slot") ||
    !Object.hasOwn(input, "value") ||
    !isSlot(input.slot) ||
    typeof input.value !== "string"
  ) {
    throw new TypeError();
  }
  if (!hasSelection) return { slot: input.slot, value: input.value };
  if (input.slot === "intervals-icu") throw new TypeError();
  const selection = parseOnboardingLlmSelection(input.selection);
  if (selection.provider !== input.slot) throw new TypeError();
  return { slot: input.slot, value: input.value, selection };
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
    return { slot: value.slot, status: "configured", runtimeReady: value.runtimeReady };
  }
  return { slot: value.slot, status: "refused", reason: value.reason };
}

export type DesktopCredentialId = DesktopCredentialSlot | typeof CHATGPT_PROFILE_NAME;

export type DesktopCredentialDeleteResult =
  | {
      readonly credential: DesktopCredentialId;
      readonly status: "deleted";
      readonly cleanupPending: boolean;
    }
  | {
      readonly credential: DesktopCredentialId;
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "managed-by-environment"
        | "storage-failed"
        | "runtime-unavailable"
        | "runtime-state-diverged";
    };

function parseDeleteInput(value: unknown): DesktopCredentialId {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "credential")
  ) {
    throw new TypeError();
  }
  const credential = (value as Record<string, unknown>).credential;
  if (credential === CHATGPT_PROFILE_NAME || isSlot(credential)) return credential;
  throw new TypeError();
}

function minimizeDelete(
  credential: DesktopCredentialId,
  value: CredentialDeleteResult | Awaited<ReturnType<ChatGptAuthController["deleteCredential"]>>,
): DesktopCredentialDeleteResult {
  if (value.status === "deleted") {
    return { credential, status: "deleted", cleanupPending: value.cleanupPending };
  }
  return { credential, status: "refused", reason: value.reason };
}

function minimizeSelection(value: OnboardingLlmSelectionResult): OnboardingLlmSelectionResult {
  if (value.status === "configured") return { status: "configured", runtimeReady: true };
  return { status: "refused", reason: value.reason };
}

function minimizeChatGptStatus(value: ChatGptStatus): ChatGptStatus {
  return { state: value.state, runtimeReady: value.runtimeReady };
}

function minimizeChatGptLogin(value: ChatGptLoginResult): ChatGptLoginResult {
  if (value.status === "configured") return { status: "configured", runtimeReady: true };
  return { status: "refused", reason: value.reason };
}

async function llmConfiguration(
  getRuntimeConfig: () => Promise<RuntimeConfigSnapshot>,
): Promise<OnboardingLlmConfiguration> {
  let active: OnboardingLlmConfiguration["active"] = null;
  try {
    const snapshot = await getRuntimeConfig();
    if (snapshot.llm.credential_configured) {
      active = { provider: snapshot.llm.provider, model: snapshot.llm.model };
    }
  } catch {}
  return {
    schemaVersion: 1,
    providers: publicLlmProviderConfiguration(),
    active,
  };
}

export function registerOnboardingIpc(options: RegisterOnboardingIpcOptions): () => void {
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!options.isTrusted(event)) throw new TypeError();
  };
  options.ipcMain.handle(DESKTOP_CREDENTIAL_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    try {
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
      const stored =
        input.slot !== "intervals-icu" && input.selection === undefined
          ? await options.vault.writeCredential(input, { activate: false })
          : await options.vault.writeCredential(input);
      return minimizeWrite(stored);
    } catch {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    }
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_DELETE_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const credential = parseDeleteInput(args[0]);
    if (credential === CHATGPT_PROFILE_NAME) {
      return minimizeDelete(credential, await options.chatGptAuth.deleteCredential());
    }
    const statuses = await options.vault.credentialStatuses();
    const local = statuses.find((status) => status.slot === credential);
    if (local?.state === "missing") {
      let active = false;
      try {
        const snapshot = await options.getRuntimeConfig();
        active =
          credential === "intervals-icu"
            ? snapshot.intervals.credential_configured
            : snapshot.llm.provider === credential && snapshot.llm.credential_configured;
      } catch {
        return {
          credential,
          status: "refused",
          reason: "runtime-unavailable",
        };
      }
      return {
        credential,
        status: "refused",
        reason: active ? "managed-by-environment" : "not-found",
      };
    }
    return minimizeDelete(credential, await options.vault.deleteCredential(credential));
  });
  options.ipcMain.handle(DESKTOP_LLM_CONFIGURATION_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return llmConfiguration(options.getRuntimeConfig);
  });
  options.ipcMain.handle(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    let selection: OnboardingLlmSelection;
    try {
      selection = parseOnboardingLlmSelection(args[0]);
    } catch {
      return { status: "refused", reason: "invalid-input" };
    }
    try {
      if (await options.applyExistingLlmSelection(selection)) {
        return { status: "configured", runtimeReady: true };
      }
      const result =
        selection.provider === "openai-codex"
          ? await options.chatGptAuth.activate(parseChatGptLlmSelection(selection))
          : await options.vault.applyLlmSelection(selection);
      return minimizeSelection(result);
    } catch {
      return { status: "refused", reason: "runtime-unavailable" };
    }
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return minimizeChatGptStatus(await options.chatGptAuth.status());
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_LOGIN_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const selection = parseChatGptLlmSelection(args[0]);
    return minimizeChatGptLogin(await options.chatGptAuth.login(selection));
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
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_DELETE_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_LLM_CONFIGURATION_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_LLM_SELECTION_APPLY_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_LOGIN_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL);
  };
}
