export type TelegramControlErrorCode =
  | "telegram-invalid-token"
  | "telegram-polling-conflict"
  | "telegram-start-failed"
  | "telegram-credential-storage-failed"
  | "telegram-credential-encryption-unavailable"
  | "telegram-credential-unsafe-backend"
  | "telegram-credential-unavailable"
  | "telegram-settings-storage-uncertain"
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
    | "suspended"
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
        | "telegram-pairing-storage-failed"
        | "telegram-pairing-storage-uncertain";
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

export type TelegramMutationReason =
  | "clipboard-unavailable"
  | "clipboard-clear-failed"
  | "invalid-token-format"
  | "invalid-token"
  | "validation-unavailable"
  | "webhook-removal-required"
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "storage-uncertain"
  | "control-uncertain"
  | "stale-operation"
  | "transfer-required"
  | "polling-conflict"
  | "control-unavailable"
  | "invalid-state";

export type TelegramMutationResult =
  | { readonly outcome: "applied"; readonly current: TelegramControlStatus }
  | {
      readonly outcome: "refused";
      readonly reason: Exclude<TelegramMutationReason, "storage-uncertain" | "control-uncertain">;
      readonly current: TelegramControlStatus;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain" | "control-uncertain";
      readonly current: TelegramControlStatus;
    };

export interface TelegramSettingsFeedback {
  readonly tone: "status" | "success" | "error" | "warning";
  readonly message: string;
}

export interface TelegramAllowedSender {
  readonly senderId: number;
  readonly role: "primary" | "additional";
  readonly addedAt?: string;
}

export interface TelegramAllowedSenders {
  readonly senders: readonly TelegramAllowedSender[];
}

export type TelegramAllowedSendersMutationResult =
  | { readonly outcome: "applied"; readonly current: TelegramAllowedSenders }
  | { readonly outcome: "refused"; readonly reason: "invalid-state" | "control-unavailable" }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain" | "control-uncertain";
    };

export interface TelegramSettingsBridge {
  status(): Promise<TelegramControlStatus>;
  pasteTokenFromClipboard(): Promise<TelegramMutationResult>;
  enable(): Promise<TelegramMutationResult>;
  disable(): Promise<TelegramMutationResult>;
  remove(): Promise<TelegramMutationResult>;
  reconcile(): Promise<TelegramMutationResult>;
  removeWebhook(): Promise<TelegramMutationResult>;
  beginPairing(): Promise<TelegramMutationResult>;
  cancelPairing(): Promise<TelegramMutationResult>;
  acknowledgeGapWarning(): Promise<TelegramMutationResult>;
  listAllowedSenders(): Promise<TelegramAllowedSenders>;
  addAllowedSender(senderId: number): Promise<TelegramAllowedSendersMutationResult>;
  removeAllowedSender(senderId: number): Promise<TelegramAllowedSendersMutationResult>;
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
  readonly healthAnnouncement: string;
  readonly feedback: TelegramSettingsFeedback | null;
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

interface TelegramFeedbackProvenance {
  readonly kind: "pairing-instruction" | "success";
  readonly telegram: TelegramControlStatus | null;
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
  if (action === "remove") return "Deleting the Telegram connection…";
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

function mutationFailureCopy(
  action: TelegramSettingsAction,
  result: Exclude<TelegramMutationResult, { readonly outcome: "applied" }>,
): string {
  if (
    action === "begin-pairing" &&
    result.current.pairing.state === "failed" &&
    result.current.pairing.errorCode === "telegram-pairing-storage-uncertain"
  ) {
    return "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.";
  }
  if (result.outcome === "uncertain") {
    if (result.reason === "control-uncertain") {
      if (action === "paste-token") {
        return "The Telegram connection may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check Telegram before trying again.";
      }
      if (action === "remove") {
        return "Telegram connection deletion may not have completed. Restart Enduragent and check whether the bot is still connected before trying again.";
      }
      return "The Telegram change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check this setting before trying again.";
    }
    if (action === "paste-token") {
      return "The copied token was not applied because secure storage could not be verified. The current Telegram bot is unchanged. Restart Enduragent and check Telegram before trying again.";
    }
    if (action === "remove") {
      return "Telegram connection deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and check Telegram before trying again.";
    }
    return "The change was not applied because storage could not be verified. Restart Enduragent and check this setting before trying again.";
  }
  if (result.reason === "encryption-unavailable") {
    if (action !== "paste-token") {
      return "Secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, then choose Check again.";
    }
    return result.current.credentialConfigured
      ? "The current Telegram bot is unchanged because secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, copy the bot token again, then retry."
      : "Secure token storage is unavailable. Quit and reopen Enduragent, unlock or approve Keychain access, copy the bot token again, then retry.";
  }
  if (result.reason === "unsafe-backend") {
    if (action !== "paste-token") {
      return "No secure credential backend is available, so Enduragent refused to access the saved bot token without encryption. Quit and reopen Enduragent, then choose Check again.";
    }
    return result.current.credentialConfigured
      ? "The current Telegram bot is unchanged because no secure credential backend is available. Enduragent refused to save the copied token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry."
      : "No secure credential backend is available, so Enduragent refused to save the bot token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.";
  }
  if (action === "paste-token") {
    switch (result.reason) {
      case "clipboard-unavailable":
        return "The clipboard could not be read. No Telegram token was used.";
      case "clipboard-clear-failed":
        return "The clipboard could not be cleared, so the copied token was not used. The current Telegram bot is unchanged.";
      case "invalid-token-format":
        return "The clipboard does not contain a valid Telegram bot token. The current Telegram bot is unchanged.";
      case "invalid-token":
        return "Telegram rejected the copied token. The current Telegram bot is unchanged.";
      case "validation-unavailable":
        return "Telegram could not verify the copied token right now. The current Telegram bot is unchanged.";
      case "webhook-removal-required":
        return result.current.bot.state === "webhook-removal-required"
          ? "The copied bot still uses a webhook. Remove the webhook before pairing it with this Mac."
          : "The copied bot still uses a webhook. Remove the webhook, then delete the current connection and connect this bot.";
      case "storage-failed":
        return "The copied token could not be stored. The current Telegram bot is unchanged.";
      default:
        return "The copied token was not applied. The current Telegram bot is unchanged.";
    }
  }
  return failureCopy(action);
}

type ActiveTelegramPairingStatus = TelegramControlStatus & {
  readonly bot: { readonly state: "ready"; readonly username: string };
  readonly pairing: {
    readonly state: "awaiting-code";
    readonly code: string;
    readonly expiresAt: string;
  };
};

export function hasActiveTelegramPairingCode(
  status: TelegramControlStatus,
): status is ActiveTelegramPairingStatus {
  if (status.bot.state !== "ready" || status.pairing.state !== "awaiting-code") return false;
  if (!status.credentialConfigured || status.channel.desiredState !== "enabled") return false;
  return (
    status.channel.state === "starting" ||
    status.channel.state === "online" ||
    status.channel.state === "offline-retrying" ||
    status.channel.state === "suspended"
  );
}

function channelHealthCopy(status: TelegramControlStatus): string {
  if (status.channel.state === "online") return "Telegram is online.";
  if (status.channel.state === "starting") return "Telegram is connecting.";
  if (status.channel.state === "suspended") {
    return "Telegram polling is paused while this Mac sleeps.";
  }
  if (status.channel.state === "disabled") return "Telegram is off.";
  if (status.channel.state === "waiting-for-credential") {
    return "Copy a bot token from BotFather, then paste it from the clipboard.";
  }
  if (status.channel.state === "invalid-token") {
    return "Telegram rejected this token. Delete the connection, then connect a new bot with a fresh token from BotFather.";
  }
  if (status.channel.state === "conflict") {
    return "Another service is polling this bot. Stop that deployment, then check again.";
  }
  if (status.channel.state === "transfer-required") {
    return "This bot is still owned by another Desktop installation. Delete the connection there before connecting it here.";
  }
  if (status.channel.state === "offline-retrying") {
    return "Telegram is offline. Enduragent will keep trying while this Mac is awake and online.";
  }
  return "Telegram needs attention. Keep the app open, check the connection, and try again.";
}

function resultCopy(action: TelegramSettingsAction, status: TelegramControlStatus): string {
  if (status.gapWarning.state === "possible-message-loss") {
    return "Telegram reconnected after a long gap. Some messages may not have arrived.";
  }
  if (status.bot.state === "webhook-removal-required") {
    return "Bot verified. Remove its webhook before pairing it with this Mac.";
  }
  if (hasActiveTelegramPairingCode(status)) {
    return "Pairing code ready. Send it to the bot in Telegram.";
  }
  if (status.pairing.state === "paired" && action === "begin-pairing") {
    return "Telegram is paired with its primary user.";
  }
  if (status.channel.state === "disabled" && action === "remove") {
    return "Telegram connection deleted from this Mac.";
  }
  return channelHealthCopy(status);
}

function sameBotTruth(left: TelegramBotStatus, right: TelegramBotStatus): boolean {
  if (left.state === "unconfigured" || right.state === "unconfigured") {
    return left.state === right.state;
  }
  return left.state === right.state && left.username === right.username;
}

function samePairingTruth(left: TelegramPairingStatus, right: TelegramPairingStatus): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "awaiting-code" && right.state === "awaiting-code") {
    return left.code === right.code && left.expiresAt === right.expiresAt;
  }
  if (left.state === "failed" && right.state === "failed") {
    return left.errorCode === right.errorCode;
  }
  return true;
}

function sameFeedbackTruth(left: TelegramControlStatus, right: TelegramControlStatus): boolean {
  return (
    left.channel.desiredState === right.channel.desiredState &&
    left.channel.state === right.channel.state &&
    sameBotTruth(left.bot, right.bot) &&
    samePairingTruth(left.pairing, right.pairing)
  );
}

function pairingInstructionRemainsValid(
  origin: TelegramControlStatus,
  current: TelegramControlStatus,
): boolean {
  if (origin.pairing.state !== "awaiting-code" || !hasActiveTelegramPairingCode(current))
    return false;
  if (!sameBotTruth(origin.bot, current.bot)) return false;
  if (origin.pairing.code !== current.pairing.code) return false;
  if (origin.pairing.expiresAt !== current.pairing.expiresAt) return false;
  return true;
}

function botUsername(status: TelegramBotStatus): string | null {
  return status.state === "unconfigured" ? null : status.username;
}

function pairingFailureCopy(
  pairing: Extract<TelegramPairingStatus, { readonly state: "failed" }>,
): string {
  if (pairing.errorCode === "telegram-pairing-storage-uncertain") {
    return "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.";
  }
  if (pairing.errorCode === "telegram-pairing-storage-failed") {
    return "The primary Telegram user could not be saved. Check local disk access and try pairing again.";
  }
  if (pairing.errorCode === "telegram-pairing-refused") {
    return "Pairing was refused because this bot already has a primary user.";
  }
  return "Pairing is unavailable until the Telegram bot can connect.";
}

function pairingTransitionCopy(
  previous: TelegramControlStatus,
  current: TelegramControlStatus,
  action?: TelegramSettingsAction,
): string | null {
  const previousBot = botUsername(previous.bot);
  const currentBot = botUsername(current.bot);
  if (previousBot !== currentBot) {
    if (currentBot === null) return "Telegram connection deleted from this Mac.";
    if (previousBot !== null || action === "paste-token") {
      return `Telegram connected to @${currentBot}. Pairing needs to be set up.`;
    }
  }
  if (previous.pairing.state !== "awaiting-code") return null;
  if (current.pairing.state === "awaiting-code") {
    if (samePairingTruth(previous.pairing, current.pairing)) return null;
    return hasActiveTelegramPairingCode(current)
      ? "A new Telegram pairing code is ready. Send it to the bot in Telegram."
      : null;
  }
  if (current.pairing.state === "paired") {
    return "Telegram is paired with its primary user.";
  }
  if (current.pairing.state === "expired") {
    return "The pairing code expired before it was used. Create a new code when you are ready.";
  }
  if (current.pairing.state === "failed") return pairingFailureCopy(current.pairing);
  if (current.pairing.state === "unpaired") return "Telegram pairing was cancelled.";
  return null;
}

function pollingAnnouncement(
  previous: TelegramControlStatus,
  current: TelegramControlStatus,
): string {
  return (
    pairingTransitionCopy(previous, current) ??
    (previous.channel.state === current.channel.state ? "" : channelHealthCopy(current))
  );
}

function feedbackIsSuperseded(
  feedback: TelegramSettingsFeedback | null,
  provenance: TelegramFeedbackProvenance | null,
  current: TelegramControlStatus,
): boolean {
  if (feedback === null || provenance?.telegram === null || provenance?.telegram === undefined) {
    return false;
  }
  if (provenance.kind === "pairing-instruction") {
    return !pairingInstructionRemainsValid(provenance.telegram, current);
  }
  if (feedback.tone !== "success") return false;
  return !sameFeedbackTruth(provenance.telegram, current);
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
  let feedbackProvenance: TelegramFeedbackProvenance | null = null;
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
        healthAnnouncement: "",
        feedback: null,
      };
    }
    return {
      telegram: currentState.telegram,
      allowedSenders: currentState.allowedSenders,
      senderLoadFailed: currentState.senderLoadFailed,
      announcement: currentState.announcement,
      healthAnnouncement: currentState.healthAnnouncement,
      feedback: currentState.feedback,
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
            const recoveredLoadFailure =
              currentState.status === "error" && currentState.kind === "load";
            const previous = readCurrentContent();
            const healthAnnouncement =
              previous.telegram === null
                ? ""
                : pollingAnnouncement(previous.telegram, content.telegram);
            const feedbackSuperseded = feedbackIsSuperseded(
              previous.feedback,
              feedbackProvenance,
              content.telegram,
            );
            const clearFeedback = recoveredLoadFailure || feedbackSuperseded;
            if (clearFeedback) feedbackProvenance = null;
            render({
              status: "ready",
              ...content,
              announcement: clearFeedback ? "" : previous.announcement,
              healthAnnouncement,
              feedback: clearFeedback ? null : previous.feedback,
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
            feedbackProvenance = null;
            render({
              status: "ready",
              ...content,
              announcement: resultCopy("reconcile", content.telegram),
              healthAnnouncement: "",
              feedback: null,
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
              healthAnnouncement: "",
              feedback: {
                tone: "error",
                message: "Telegram settings aren’t available. Keep the app open and try again.",
              },
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
    invoke: () => Promise<TelegramMutationResult>,
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
      feedback: { tone: "status", message: workingCopy(action) },
    });
    const pending = Promise.resolve()
      .then(invoke)
      .then((result) => {
        return contentFor(result.current).then((content) => ({ content, result }));
      })
      .then(
        ({ content, result }) => {
          if (!disposed && generation === operationGeneration) {
            const transitionMessage =
              result.outcome === "applied" && previous.telegram !== null
                ? pairingTransitionCopy(previous.telegram, content.telegram, action)
                : null;
            const message =
              result.outcome === "applied"
                ? (transitionMessage ?? resultCopy(action, content.telegram))
                : mutationFailureCopy(action, result);
            feedbackProvenance =
              result.outcome === "applied"
                ? {
                    kind: hasActiveTelegramPairingCode(content.telegram)
                      ? "pairing-instruction"
                      : "success",
                    telegram: content.telegram,
                  }
                : null;
            render({
              status: "ready",
              ...content,
              announcement: message,
              healthAnnouncement: previous.healthAnnouncement,
              feedback: {
                tone:
                  result.outcome === "applied"
                    ? "success"
                    : result.outcome === "uncertain"
                      ? "warning"
                      : "error",
                message,
              },
            });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            feedbackProvenance = null;
            render({
              status: "error",
              kind: "action",
              ...previous,
              announcement: failureCopy(action),
              feedback: { tone: "error", message: failureCopy(action) },
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
    invoke: () => Promise<TelegramAllowedSendersMutationResult>,
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
      feedback: { tone: "status", message: workingCopy(action) },
    });
    const pending = Promise.resolve()
      .then(invoke)
      .then(
        (result) => {
          if (!disposed && generation === operationGeneration) {
            if (result.outcome === "uncertain") {
              feedbackProvenance = null;
              const message =
                result.reason === "storage-uncertain"
                  ? "The allowed-user list may have changed, but Enduragent could not verify storage. Restart Enduragent and check the list before trying again."
                  : "The allowed-user list may have changed, but Enduragent lost confirmation from the local coaching service. Restart Enduragent and check the list before trying again.";
              render({
                status: "ready",
                ...previous,
                announcement: message,
                feedback: { tone: "warning", message },
              });
              return;
            }
            if (result.outcome === "refused") {
              feedbackProvenance = null;
              const message = failureCopy(action);
              render({
                status: "ready",
                ...previous,
                announcement: message,
                feedback: { tone: "error", message },
              });
              return;
            }
            feedbackProvenance = { kind: "success", telegram: previous.telegram };
            render({
              status: "ready",
              ...previous,
              allowedSenders: result.current,
              senderLoadFailed: false,
              announcement:
                action === "add-sender" ? "Telegram user added." : "Telegram user removed.",
              feedback: {
                tone: "success",
                message:
                  action === "add-sender" ? "Telegram user added." : "Telegram user removed.",
              },
            });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            feedbackProvenance = null;
            render({
              status: "error",
              kind: "action",
              ...previous,
              announcement: failureCopy(action),
              feedback: { tone: "error", message: failureCopy(action) },
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
      feedbackProvenance = null;
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
      feedbackProvenance = null;
      input.view.dispose();
    },
  };
}
