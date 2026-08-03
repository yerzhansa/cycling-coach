export interface TrayTelegramStatus {
  readonly channelState:
    | "disabled"
    | "waiting-for-credential"
    | "starting"
    | "online"
    | "offline-retrying"
    | "conflict"
    | "invalid-token"
    | "transfer-required"
    | "failed";
  readonly gapWarning: boolean;
}

export interface TrayTelegramPresentation {
  readonly copy: string;
  readonly tag: string;
  readonly tone: "active" | "idle" | "warning" | "failed";
}

export function presentTrayTelegramStatus(status: TrayTelegramStatus): TrayTelegramPresentation {
  if (status.gapWarning) {
    return { copy: "Check for missed messages", tag: "warning", tone: "warning" };
  }
  if (status.channelState === "online") {
    return { copy: "Connected to Telegram", tag: "online", tone: "active" };
  }
  if (status.channelState === "starting") {
    return { copy: "Connecting to Telegram", tag: "starting", tone: "idle" };
  }
  if (status.channelState === "offline-retrying") {
    return { copy: "Telegram is reconnecting", tag: "retrying", tone: "warning" };
  }
  if (status.channelState === "conflict") {
    return { copy: "Another poller owns the bot", tag: "conflict", tone: "failed" };
  }
  if (status.channelState === "invalid-token") {
    return { copy: "Telegram token rejected", tag: "attention", tone: "failed" };
  }
  if (status.channelState === "transfer-required") {
    return { copy: "Bot transfer required", tag: "attention", tone: "failed" };
  }
  if (status.channelState === "failed") {
    return { copy: "Telegram needs attention", tag: "attention", tone: "failed" };
  }
  return { copy: "Telegram is off", tag: "off", tone: "idle" };
}
