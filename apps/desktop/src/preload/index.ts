import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_LIFECYCLE_CHANNEL,
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_RELEASE_NOTES_CHANNEL,
  DESKTOP_UPDATE_CHECK_CHANNEL,
  DESKTOP_UPDATE_GET_CHANNEL,
  DESKTOP_UPDATE_RESTART_CHANNEL,
  DESKTOP_UPDATE_STATE_CHANNEL,
} from "../main/constants.js";

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
const RELEASES_URL = "https://github.com/yerzhansa/cycling-coach/releases";
const RELEASE_NOTES_MAX_TOTAL_BYTES = 64 * 1024;
const RELEASE_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const textEncoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeString(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function releaseVersion(value: unknown): value is string {
  return safeString(value, 64) && RELEASE_VERSION_RE.test(value);
}

function releaseTagUrl(version: string): string {
  return `${RELEASES_URL}/tag/cycling-coach@${encodeURIComponent(version)}`;
}

function parseReleaseNotes(value: unknown): unknown {
  if (!record(value) || (value.status !== "available" && value.status !== "unavailable")) {
    throw new TypeError();
  }
  if (value.status === "unavailable") {
    if (
      !exactKeys(value, ["status", "version", "releaseUrl"]) ||
      (value.version !== null && !releaseVersion(value.version)) ||
      typeof value.releaseUrl !== "string" ||
      value.releaseUrl.length > 2_048 ||
      value.releaseUrl !== (value.version === null ? RELEASES_URL : releaseTagUrl(value.version))
    ) {
      throw new TypeError();
    }
    return {
      status: "unavailable",
      version: value.version,
      releaseUrl: value.releaseUrl,
    };
  }
  if (
    !exactKeys(value, ["status", "version", "notes", "releaseUrl"]) ||
    !releaseVersion(value.version) ||
    !Array.isArray(value.notes) ||
    value.notes.length > 100 ||
    typeof value.releaseUrl !== "string" ||
    value.releaseUrl.length > 2_048 ||
    value.releaseUrl !== releaseTagUrl(value.version)
  ) {
    throw new TypeError();
  }
  let totalBytes = 0;
  const notes = value.notes.map((note) => {
    if (!safeString(note, 2_000)) throw new TypeError();
    totalBytes += textEncoder.encode(note).byteLength;
    if (totalBytes > RELEASE_NOTES_MAX_TOTAL_BYTES) throw new TypeError();
    return note;
  });
  return {
    status: "available",
    version: value.version,
    notes,
    releaseUrl: value.releaseUrl,
  };
}

type PreloadUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | { readonly status: "downloading" | "downloaded" | "installing"; readonly version: string }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

function parseUpdateState(value: unknown): PreloadUpdateState {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (["disabled", "idle", "checking", "current"].includes(value.status)) {
    if (!exactKeys(value, ["status"])) throw new TypeError();
    return { status: value.status as "disabled" | "idle" | "checking" | "current" };
  }
  if (["downloading", "downloaded", "installing"].includes(value.status)) {
    if (
      !exactKeys(value, ["status", "version"]) ||
      !safeString(value.version, 64) ||
      !STABLE_VERSION_RE.test(value.version)
    ) {
      throw new TypeError();
    }
    return {
      status: value.status as "downloading" | "downloaded" | "installing",
      version: value.version,
    };
  }
  if (
    value.status !== "failed" ||
    !exactKeys(value, ["status", "stage"]) ||
    (value.stage !== "check" && value.stage !== "download")
  ) {
    throw new TypeError();
  }
  return { status: "failed", stage: value.stage };
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
const updateListeners = new Set<(state: PreloadUpdateState) => void>();

window.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const anchor = event
      .composedPath()
      .find((candidate): candidate is HTMLAnchorElement => candidate instanceof HTMLAnchorElement);
    if (anchor === undefined || anchor.target !== "_blank") return;
    event.preventDefault();
    ipcRenderer.send(DESKTOP_OPEN_EXTERNAL_CHANNEL, anchor.href);
  },
  true,
);

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

ipcRenderer.on(DESKTOP_UPDATE_STATE_CHANNEL, (_event, value: unknown) => {
  let state: PreloadUpdateState;
  try {
    state = parseUpdateState(value);
  } catch {
    return;
  }
  for (const listener of updateListeners) {
    try {
      listener(parseUpdateState(state));
    } catch {}
  }
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
    releaseNotes: async () =>
      parseReleaseNotes(await ipcRenderer.invoke(DESKTOP_RELEASE_NOTES_CHANNEL)),
    getUpdateState: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_GET_CHANNEL)),
    checkForUpdates: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_CHECK_CHANNEL)),
    restartToUpdate: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_RESTART_CHANNEL)),
    onUpdateState: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (state: PreloadUpdateState) => void;
      updateListeners.add(typedListener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        updateListeners.delete(typedListener);
      };
    },
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
