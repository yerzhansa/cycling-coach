import { contextBridge, ipcRenderer } from "electron";

const DESKTOP_TRAY_TELEGRAM_STATUS_CHANNEL = "desktop:tray:telegram-status";

const CHANNEL_STATES = new Set([
  "disabled",
  "waiting-for-credential",
  "starting",
  "online",
  "offline-retrying",
  "conflict",
  "invalid-token",
  "transfer-required",
  "failed",
]);

function copyStatus(
  value: unknown,
): { readonly channelState: string; readonly gapWarning: boolean } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["channelState", "gapWarning"]) ||
    typeof record.channelState !== "string" ||
    !CHANNEL_STATES.has(record.channelState) ||
    typeof record.gapWarning !== "boolean"
  ) {
    return undefined;
  }
  return { channelState: record.channelState, gapWarning: record.gapWarning };
}

contextBridge.exposeInMainWorld("enduragentTray", {
  onTelegramStatus(listener: (status: unknown) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("invalid tray status listener");
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const status = copyStatus(value);
      if (status !== undefined) listener(status);
    };
    ipcRenderer.on(DESKTOP_TRAY_TELEGRAM_STATUS_CHANNEL, receive);
    return () => ipcRenderer.removeListener(DESKTOP_TRAY_TELEGRAM_STATUS_CHANNEL, receive);
  },
});
