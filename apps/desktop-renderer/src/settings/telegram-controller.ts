export type TelegramControlState =
  | "disabled"
  | "waiting-for-credential"
  | "starting"
  | "online"
  | "offline-retrying"
  | "conflict"
  | "invalid-token"
  | "transfer-required"
  | "failed";

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

export interface TelegramControlStatus {
  readonly desiredState: "disabled" | "enabled";
  readonly state: TelegramControlState;
  readonly credentialConfigured: boolean;
  readonly botUsername?: string;
  readonly since?: string;
  readonly lastSuccessfulPollAt?: string;
  readonly retryCount?: number;
  readonly errorCode?: TelegramControlErrorCode;
}

export interface TelegramSettingsBridge {
  status(): Promise<TelegramControlStatus>;
  pasteTokenFromClipboard(): Promise<TelegramControlStatus>;
  enable(): Promise<TelegramControlStatus>;
  disable(): Promise<TelegramControlStatus>;
  remove(): Promise<TelegramControlStatus>;
  reconcile(): Promise<TelegramControlStatus>;
}

export type TelegramSettingsAction = "paste-token" | "enable" | "disable" | "remove" | "reconcile";

interface TelegramSettingsContent {
  readonly channel: TelegramControlStatus | null;
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

export interface TelegramSettingsView {
  bind(handlers: {
    readonly onRetry: () => void;
    readonly onPasteToken: () => void;
    readonly onEnable: () => void;
    readonly onDisable: () => void;
    readonly onRemove: () => void;
    readonly onReconcile: () => void;
  }): void;
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

function workingCopy(action: TelegramSettingsAction): string {
  if (action === "paste-token") return "Reading and saving the Telegram token…";
  if (action === "enable") return "Connecting Telegram…";
  if (action === "disable") return "Disconnecting Telegram…";
  if (action === "remove") return "Removing Telegram from this Mac…";
  return "Checking the Telegram connection…";
}

function resultCopy(action: TelegramSettingsAction, status: TelegramControlStatus): string {
  if (status.state === "online") return "Telegram is connected.";
  if (status.state === "starting") return "Telegram is connecting.";
  if (status.state === "disabled") {
    return action === "remove" ? "Telegram was removed from this Mac." : "Telegram is off.";
  }
  if (status.state === "waiting-for-credential") {
    return "Paste a bot token from the clipboard to continue.";
  }
  if (status.state === "invalid-token") {
    return "Telegram rejected this token. Copy a fresh token and replace it.";
  }
  if (status.state === "conflict") {
    return "Another service is using this bot. Stop it there, then check again.";
  }
  if (status.state === "transfer-required") {
    return "Stop the bot on its previous host, then check again here.";
  }
  if (status.state === "offline-retrying") {
    return "Telegram is offline. Cycling Coach will keep trying while this Mac is awake.";
  }
  return "Telegram needs attention. Check the connection and try again.";
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

  const activate = (): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    if (pollTimer === undefined) {
      pollTimer = schedule(() => {
        if (disposed || operation !== undefined || pollTask !== undefined) return;
        const pollGeneration = generation;
        const pendingPoll = Promise.resolve()
          .then(() => input.bridge.status())
          .then(
            (channel) => {
              if (
                !disposed &&
                generation === pollGeneration &&
                currentState.status !== "closed" &&
                currentState.status !== "working"
              ) {
                render({
                  status: "ready",
                  channel,
                  announcement: resultCopy("reconcile", channel),
                });
              }
            },
            () => undefined,
          )
          .finally(() => {
            if (pollTask === pendingPoll) pollTask = undefined;
          });
        pollTask = pendingPoll;
      }, pollIntervalMs);
    }
    const operationGeneration = ++generation;
    render({ status: "loading" });
    const pending = Promise.resolve()
      .then(() => input.bridge.status())
      .then(
        (channel) => {
          if (!disposed && generation === operationGeneration) {
            render({ status: "ready", channel, announcement: resultCopy("reconcile", channel) });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "load",
              channel: null,
              announcement: "Telegram settings aren’t available. Try again.",
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

  const run = (
    action: TelegramSettingsAction,
    invoke: () => Promise<TelegramControlStatus>,
  ): void => {
    if (disposed || operation !== undefined) return;
    const release = input.beginMutation();
    if (release === null) return;
    const previous = "channel" in currentState ? currentState.channel : null;
    const operationGeneration = ++generation;
    render({
      status: "working",
      operation: action,
      channel: previous,
      announcement: workingCopy(action),
    });
    const pending = Promise.resolve()
      .then(invoke)
      .then(
        (channel) => {
          if (!disposed && generation === operationGeneration) {
            render({ status: "ready", channel, announcement: resultCopy(action, channel) });
          }
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "action",
              channel: previous,
              announcement: "Telegram settings couldn’t be changed. Try again.",
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
    onPasteToken: () => run("paste-token", () => input.bridge.pasteTokenFromClipboard()),
    onEnable: () => run("enable", () => input.bridge.enable()),
    onDisable: () => run("disable", () => input.bridge.disable()),
    onRemove: () => run("remove", () => input.bridge.remove()),
    onReconcile: () => run("reconcile", () => input.bridge.reconcile()),
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
