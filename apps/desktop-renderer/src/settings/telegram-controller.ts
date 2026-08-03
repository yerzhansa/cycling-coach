export type TelegramControlErrorCode =
  | "telegram-invalid-token"
  | "telegram-polling-conflict"
  | "telegram-start-failed"
  | "telegram-credential-storage-failed"
  | "telegram-credential-unavailable"
  | "telegram-daemon-unavailable"
  | "telegram-home-mismatch"
  | "telegram-stale-operation"
  | "telegram-control-failed"
  | "telegram-drain-required";

export interface TelegramChannelStatus {
  readonly desiredState: "disabled" | "enabled";
  readonly state:
    | "disabled"
    | "waiting-for-credential"
    | "starting"
    | "online"
    | "offline-retrying"
    | "conflict"
    | "invalid-token"
    | "transfer-required"
    | "failed";
  readonly since?: string;
  readonly lastSuccessfulPollAt?: string;
  readonly retryCount?: number;
  readonly errorCode?: TelegramControlErrorCode;
}

export type TelegramBotStatus =
  | { readonly state: "unconfigured" }
  | {
      readonly state: "ready" | "webhook-removal-required";
      readonly username: string;
    };

export type TelegramPairingStatus =
  | { readonly state: "unpaired" | "paired" | "expired" }
  | { readonly state: "awaiting-code"; readonly code: string; readonly expiresAt: string }
  | {
      readonly state: "failed";
      readonly errorCode:
        | "telegram-pairing-unavailable"
        | "telegram-pairing-refused"
        | "telegram-pairing-storage-failed";
    };

export type TelegramGapWarning =
  | { readonly state: "clear" }
  | { readonly state: "possible-message-loss"; readonly detectedAt: string };

export interface TelegramControlStatus {
  readonly channel: TelegramChannelStatus;
  readonly bot: TelegramBotStatus;
  readonly pairing: TelegramPairingStatus;
  readonly credentialConfigured: boolean;
  readonly gapWarning: TelegramGapWarning;
}

export interface TelegramAllowedSender {
  readonly senderId: number;
  readonly role: "primary" | "additional";
  readonly addedAt?: string;
}

export interface TelegramAllowedSenders {
  readonly senders: readonly TelegramAllowedSender[];
}

export interface TelegramSettingsBridge {
  status(): Promise<TelegramControlStatus>;
  pasteTokenFromClipboard(): Promise<TelegramControlStatus>;
  enable(): Promise<TelegramControlStatus>;
  disable(): Promise<TelegramControlStatus>;
  remove(): Promise<TelegramControlStatus>;
  reconcile(): Promise<TelegramControlStatus>;
  removeWebhook(): Promise<TelegramControlStatus>;
  beginPairing(): Promise<TelegramControlStatus>;
  cancelPairing(): Promise<TelegramControlStatus>;
  acknowledgeGapWarning(): Promise<TelegramControlStatus>;
  listAllowedSenders(): Promise<TelegramAllowedSenders>;
  addAllowedSender(senderId: number): Promise<TelegramAllowedSenders>;
  removeAllowedSender(senderId: number): Promise<TelegramAllowedSenders>;
}

export type TelegramSettingsAction =
  | "paste-token"
  | "enable"
  | "disable"
  | "remove"
  | "reconcile"
  | "remove-webhook"
  | "begin-pairing"
  | "cancel-pairing"
  | "acknowledge-gap"
  | "add-sender"
  | "remove-sender";

interface TelegramSettingsContent {
  readonly telegram: TelegramControlStatus | null;
  readonly allowedSenders: TelegramAllowedSenders | null;
  readonly senderLoadFailed: boolean;
  readonly announcement: string;
}

export type TelegramSettingsState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | ({ readonly status: "ready" } & TelegramSettingsContent)
  | ({
      readonly status: "working";
      readonly operation: TelegramSettingsAction;
    } & TelegramSettingsContent)
  | ({ readonly status: "error"; readonly kind: "load" | "action" } & TelegramSettingsContent);

interface TelegramSettingsHandlers {
  readonly onRetry: () => void;
  readonly onPasteToken: () => void;
  readonly onEnable: () => void;
  readonly onDisable: () => void;
  readonly onRemove: () => void;
  readonly onReconcile: () => void;
  readonly onRemoveWebhook: () => void;
  readonly onBeginPairing: () => void;
  readonly onCancelPairing: () => void;
  readonly onAcknowledgeGapWarning: () => void;
  readonly onAddSender: (senderId: number) => void;
  readonly onRemoveSender: (senderId: number) => void;
}

export interface TelegramSettingsView {
  bind(handlers: TelegramSettingsHandlers): void;
  close(): void;
  render(state: Exclude<TelegramSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface TelegramSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): TelegramSettingsState;
  dispose(): void;
}

const EMPTY_SENDERS = Object.freeze({
  senders: Object.freeze([]),
}) satisfies TelegramAllowedSenders;

function workingCopy(action: TelegramSettingsAction): string {
  if (action === "paste-token") return "Reading and verifying the Telegram token…";
  if (action === "enable") return "Turning Telegram on…";
  if (action === "disable") return "Turning Telegram off…";
  if (action === "remove") return "Removing this Telegram bot from the Mac…";
  if (action === "remove-webhook") return "Removing the bot’s webhook…";
  if (action === "begin-pairing") return "Creating a private pairing code…";
  if (action === "cancel-pairing") return "Cancelling pairing…";
  if (action === "acknowledge-gap") return "Clearing the Telegram delivery warning…";
  if (action === "add-sender") return "Adding a Telegram user…";
  if (action === "remove-sender") return "Removing the Telegram user…";
  return "Checking the Telegram connection…";
}

function failureCopy(action: TelegramSettingsAction): string {
  if (action === "paste-token") {
    return "The bot token could not be verified or saved. Copy a fresh token from BotFather and try again.";
  }
  if (action === "remove-webhook") {
    return "The webhook could not be removed. Check the internet connection and try again.";
  }
  if (action === "begin-pairing") {
    return "Pairing could not start. Check the bot connection and try again.";
  }
  if (action === "add-sender" || action === "remove-sender") {
    return "The allowed-user list could not be changed. Check the user ID and try again.";
  }
  return "Telegram settings could not be changed. Try again.";
}

function resultCopy(action: TelegramSettingsAction, status: TelegramControlStatus): string {
  if (status.gapWarning.state === "possible-message-loss") {
    return "Telegram reconnected after a long gap. Some messages may not have arrived.";
  }
  if (status.bot.state === "webhook-removal-required") {
    return "Bot verified. Remove its webhook before pairing it with this Mac.";
  }
  if (status.pairing.state === "awaiting-code") {
    return "Pairing code ready. Send it to the bot in Telegram.";
  }
  if (status.pairing.state === "paired" && action === "begin-pairing") {
    return "Telegram is paired with its primary user.";
  }
  if (status.channel.state === "online") return "Telegram is online.";
  if (status.channel.state === "starting") return "Telegram is connecting.";
  if (status.channel.state === "disabled") {
    return action === "remove" ? "Telegram was removed from this Mac." : "Telegram is off.";
  }
  if (status.channel.state === "waiting-for-credential") {
    return "Copy a bot token from BotFather, then paste it from the clipboard.";
  }
  if (status.channel.state === "invalid-token") {
    return "Telegram rejected this token. Copy a fresh token from BotFather and replace it.";
  }
  if (status.channel.state === "conflict") {
    return "Another service is polling this bot. Stop that deployment, then check again.";
  }
  if (status.channel.state === "transfer-required") {
    return "This bot is still owned by another Desktop installation. Remove it there before retrying here.";
  }
  if (status.channel.state === "offline-retrying") {
    return "Telegram is offline. Enduragent will keep trying while this Mac is awake and online.";
  }
  return "Telegram needs attention. Keep the app open, check the connection, and try again.";
}

async function loadSenders(
  bridge: TelegramSettingsBridge,
  telegram: TelegramControlStatus,
): Promise<Pick<TelegramSettingsContent, "allowedSenders" | "senderLoadFailed">> {
  if (telegram.pairing.state !== "paired") {
    return { allowedSenders: EMPTY_SENDERS, senderLoadFailed: false };
  }
  try {
    return { allowedSenders: await bridge.listAllowedSenders(), senderLoadFailed: false };
  } catch {
    return { allowedSenders: null, senderLoadFailed: true };
  }
}

export function createTelegramSettingsController(input: {
  readonly bridge: TelegramSettingsBridge;
  readonly beginMutation: () => (() => void) | null;
  readonly view: TelegramSettingsView;
  readonly pollIntervalMs?: number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}): TelegramSettingsController {
  let currentState: TelegramSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let operation: Promise<void> | undefined;
  let pollTask: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  const schedule = input.setInterval ?? globalThis.setInterval;
  const cancelSchedule = input.clearInterval ?? globalThis.clearInterval;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;

  const render = (state: Exclude<TelegramSettingsState, { readonly status: "closed" }>): void => {
    if (disposed) return;
    currentState = state;
    input.view.render(state);
  };

  const readCurrentContent = (): TelegramSettingsContent => {
    if (!("telegram" in currentState)) {
      return {
        telegram: null,
        allowedSenders: null,
        senderLoadFailed: false,
        announcement: "",
      };
    }
    return {
      telegram: currentState.telegram,
      allowedSenders: currentState.allowedSenders,
      senderLoadFailed: currentState.senderLoadFailed,
      announcement: currentState.announcement,
    };
  };

  const contentFor = async (
    telegram: TelegramControlStatus,
  ): Promise<{
    readonly telegram: TelegramControlStatus;
    readonly allowedSenders: TelegramAllowedSenders | null;
    readonly senderLoadFailed: boolean;
  }> => ({
    telegram,
    ...(await loadSenders(input.bridge, telegram)),
  });

  const poll = (): void => {
    if (disposed || operation !== undefined || pollTask !== undefined) return;
    const pollGeneration = generation;
    const pendingPoll = Promise.resolve()
      .then(() => input.bridge.status())
      .then(async (telegram) => ({ telegram, ...(await loadSenders(input.bridge, telegram)) }))
      .then(
        (content) => {
          if (
            !disposed &&
            generation === pollGeneration &&
            currentState.status !== "closed" &&
            currentState.status !== "working"
          ) {
            render({
              status: "ready",
              ...content,
              announcement: resultCopy("reconcile", content.telegram),
            });
          }
        },
        () => undefined,
      )
      .finally(() => {
        if (pollTask === pendingPoll) pollTask = undefined;
      });
    pollTask = pendingPoll;
  };

  const activate = (): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    if (pollTimer === undefined) pollTimer = schedule(poll, pollIntervalMs);
    const operationGeneration = ++generation;
    render({ status: "loading" });
    const pending = Promise.resolve()
      .then(() => input.bridge.status())
      .then((telegram) => contentFor(telegram))
      .then(
        (content) => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "ready",
              ...content,
              announcement: resultCopy("reconcile", content.telegram),
            });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "load",
              telegram: null,
              allowedSenders: null,
              senderLoadFailed: false,
              announcement: "Telegram settings aren’t available. Keep the app open and try again.",
            });
          }
        },
      )
      .finally(() => {
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  const runStatus = (
    action: TelegramSettingsAction,
    invoke: () => Promise<TelegramControlStatus>,
  ): void => {
    if (disposed || operation !== undefined) return;
    const release = input.beginMutation();
    if (release === null) return;
    const previous = readCurrentContent();
    const operationGeneration = ++generation;
    render({
      status: "working",
      operation: action,
      ...previous,
      announcement: workingCopy(action),
    });
    const pending = Promise.resolve()
      .then(invoke)
      .then((telegram) => contentFor(telegram))
      .then(
        (content) => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "ready",
              ...content,
              announcement: resultCopy(action, content.telegram),
            });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "action",
              ...previous,
              announcement: failureCopy(action),
            });
          }
        },
      )
      .finally(() => {
        release();
        if (operation === pending) operation = undefined;
      });
    operation = pending;
  };

  const runSenders = (
    action: "add-sender" | "remove-sender",
    invoke: () => Promise<TelegramAllowedSenders>,
  ): void => {
    if (disposed || operation !== undefined) return;
    const release = input.beginMutation();
    if (release === null) return;
    const previous = readCurrentContent();
    const operationGeneration = ++generation;
    render({
      status: "working",
      operation: action,
      ...previous,
      announcement: workingCopy(action),
    });
    const pending = Promise.resolve()
      .then(invoke)
      .then(
        (allowedSenders) => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "ready",
              ...previous,
              allowedSenders,
              senderLoadFailed: false,
              announcement:
                action === "add-sender" ? "Telegram user added." : "Telegram user removed.",
            });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "action",
              ...previous,
              announcement: failureCopy(action),
            });
          }
        },
      )
      .finally(() => {
        release();
        if (operation === pending) operation = undefined;
      });
    operation = pending;
  };

  input.view.bind({
    onRetry: () => void activate(),
    onPasteToken: () => runStatus("paste-token", () => input.bridge.pasteTokenFromClipboard()),
    onEnable: () => runStatus("enable", () => input.bridge.enable()),
    onDisable: () => runStatus("disable", () => input.bridge.disable()),
    onRemove: () => runStatus("remove", () => input.bridge.remove()),
    onReconcile: () => runStatus("reconcile", () => input.bridge.reconcile()),
    onRemoveWebhook: () => runStatus("remove-webhook", () => input.bridge.removeWebhook()),
    onBeginPairing: () => runStatus("begin-pairing", () => input.bridge.beginPairing()),
    onCancelPairing: () => runStatus("cancel-pairing", () => input.bridge.cancelPairing()),
    onAcknowledgeGapWarning: () =>
      runStatus("acknowledge-gap", () => input.bridge.acknowledgeGapWarning()),
    onAddSender: (senderId) =>
      runSenders("add-sender", () => input.bridge.addAllowedSender(senderId)),
    onRemoveSender: (senderId) =>
      runSenders("remove-sender", () => input.bridge.removeAllowedSender(senderId)),
  });

  return {
    activate,
    close() {
      if (disposed) return;
      generation += 1;
      operation = undefined;
      pollTask = undefined;
      if (pollTimer !== undefined) {
        cancelSchedule(pollTimer);
        pollTimer = undefined;
      }
      currentState = { status: "closed" };
      input.view.close();
    },
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (pollTimer !== undefined) cancelSchedule(pollTimer);
      pollTimer = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
