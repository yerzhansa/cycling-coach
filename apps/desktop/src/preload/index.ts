import { contextBridge, ipcRenderer, webUtils } from "electron";
import { DESKTOP_CONNECTION_CHANNEL, DESKTOP_LIFECYCLE_CHANNEL } from "../main/constants.js";

const DESKTOP_CREDENTIAL_STATUS_CHANNEL = "enduragent:onboarding:credential-status";
const DESKTOP_CREDENTIAL_RETRY_CHANNEL = "enduragent:onboarding:credential-retry";
const DESKTOP_CREDENTIAL_WRITE_CHANNEL = "enduragent:onboarding:credential-write";
const DESKTOP_CHATGPT_STATUS_CHANNEL = "enduragent:onboarding:chatgpt-status";
const DESKTOP_CHATGPT_LOGIN_CHANNEL = "enduragent:onboarding:chatgpt-login";
const DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL = "enduragent:onboarding:choose-import-files";

const SLOTS = new Set([
  "anthropic",
  "openrouter",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "intervals-icu",
]);
const STATES = new Set(["missing", "configured", "re-prompt"]);
const RUNTIME_STATES = new Set(["active", "stored-inactive", "failed"]);
const REASONS = new Set([
  "invalid-input",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "runtime-unavailable",
  "training-account-mismatch",
]);
const CHATGPT_REASONS = new Set([
  "already-in-progress",
  "callback-unavailable",
  "timed-out",
  "cancelled",
  "exchange-failed",
  "storage-failed",
  "runtime-unavailable",
]);
const IMPORT_EXTENSIONS = new Set([".fit", ".tcx", ".gpx"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function parseStatuses(value: unknown): unknown {
  if (
    !Array.isArray(value) ||
    value.length !== SLOTS.size ||
    new Set(value.map((entry) => (record(entry) ? entry.slot : undefined))).size !== SLOTS.size
  ) {
    throw new TypeError();
  }
  return value.map((entry) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["slot", "state", "runtimeState"]) ||
      !SLOTS.has(entry.slot as string) ||
      !STATES.has(entry.state as string) ||
      (entry.state === "configured"
        ? !RUNTIME_STATES.has(entry.runtimeState as string)
        : entry.runtimeState !== null)
    ) {
      throw new TypeError();
    }
    return { slot: entry.slot, state: entry.state, runtimeState: entry.runtimeState };
  });
}

function parseWriteResult(value: unknown): unknown {
  if (!record(value) || !SLOTS.has(value.slot as string)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["slot", "status", "runtimeReady"]) &&
    value.runtimeReady === true
  ) {
    return { slot: value.slot, status: "configured", runtimeReady: true };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["slot", "status", "reason"]) &&
    REASONS.has(value.reason as string)
  ) {
    return { slot: value.slot, status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseChatGptStatus(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["state", "runtimeReady"]) ||
    (value.state !== "configured" && value.state !== "absent") ||
    typeof value.runtimeReady !== "boolean"
  ) {
    throw new TypeError();
  }
  return { state: value.state, runtimeReady: value.runtimeReady };
}

function parseChatGptLogin(value: unknown): unknown {
  if (!record(value)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["status", "runtimeReady"]) &&
    value.runtimeReady === true
  ) {
    return { status: "configured", runtimeReady: true };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "reason"]) &&
    CHATGPT_REASONS.has(value.reason as string)
  ) {
    return { status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parsePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError();
  }
  const paths = value.map((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.length > 4_096 ||
      !path.startsWith("/") ||
      path.includes("\0")
    ) {
      throw new TypeError();
    }
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    if (dot <= slash || !IMPORT_EXTENSIONS.has(path.slice(dot).toLowerCase())) {
      throw new TypeError();
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new TypeError();
  return paths;
}

let dropDisposer: (() => void) | undefined;

ipcRenderer.on(DESKTOP_LIFECYCLE_CHANNEL, (_event, value: unknown) => {
  if (
    !record(value) ||
    !exactKeys(value, ["generation", "status"]) ||
    !["ready", "recovering", "terminal", "closing"].includes(value.status as string) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("enduragent-lifecycle", {
      detail: { status: value.status, generation: value.generation },
    }),
  );
});

contextBridge.exposeInMainWorld(
  "enduragentAuth",
  Object.freeze({
    getDaemonConnection: (failedGeneration?: number) => {
      if (
        failedGeneration !== undefined &&
        (!Number.isSafeInteger(failedGeneration) || failedGeneration < 1)
      ) {
        throw new TypeError();
      }
      return ipcRenderer.invoke(
        DESKTOP_CONNECTION_CHANNEL,
        ...(failedGeneration === undefined ? [] : [{ generation: failedGeneration }]),
      );
    },
    credentialStatuses: async () =>
      parseStatuses(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL)),
    retryFailedCredentials: async () =>
      parseStatuses(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_RETRY_CHANNEL)),
    writeCredential: async (input: unknown) => {
      if (
        !record(input) ||
        !exactKeys(input, ["slot", "value"]) ||
        !SLOTS.has(input.slot as string) ||
        typeof input.value !== "string"
      ) {
        throw new TypeError();
      }
      return parseWriteResult(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, input));
    },
    chatgptStatus: async () =>
      parseChatGptStatus(await ipcRenderer.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL)),
    chatgptLogin: async () =>
      parseChatGptLogin(await ipcRenderer.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL)),
    chooseImportFiles: async () =>
      parsePaths(await ipcRenderer.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL)),
    onDroppedImportFiles: (listener: unknown) => {
      if (typeof listener !== "function" || dropDisposer !== undefined) throw new TypeError();
      const onDrop = (event: DragEvent): void => {
        event.preventDefault();
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter((path) => path.length > 0);
        if (paths.length > 0) listener(paths);
      };
      const onDragOver = (event: DragEvent): void => event.preventDefault();
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onDrop);
      const dispose = (): void => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
        if (dropDisposer === dispose) dropDisposer = undefined;
      };
      dropDisposer = dispose;
      return dispose;
    },
  }),
);
