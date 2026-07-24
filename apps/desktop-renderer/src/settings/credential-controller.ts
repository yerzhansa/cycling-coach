import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client.js";
import type { CredentialDeleteResult, DesktopCredentialId } from "../onboarding/bridge.js";
import type { ChatGptStatus, CredentialSlotStatus } from "../onboarding/machine.js";

export type CredentialKind = "Provider API key" | "ChatGPT profile" | "Training account key";

export interface CredentialSettingsEntry {
  readonly credential: DesktopCredentialId;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly runtimeState: "active" | "stored-inactive" | "failed";
}

export type CredentialSettingsFocus =
  | { readonly target: "confirmation-cancel" | "confirmation-delete" | "setup" }
  | { readonly target: "delete"; readonly credential: DesktopCredentialId }
  | null;

interface CredentialSettingsContent {
  readonly entries: readonly CredentialSettingsEntry[];
  readonly confirmation: DesktopCredentialId | null;
  readonly announcement: string;
  readonly recoveryAvailable: boolean;
  readonly focus: CredentialSettingsFocus;
}

export type CredentialSettingsState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | ({
      readonly status: "ready" | "confirming" | "deleting" | "deleted";
    } & CredentialSettingsContent)
  | ({
      readonly status: "error";
      readonly kind: "delete";
      readonly reason: Extract<CredentialDeleteResult, { readonly status: "refused" }>["reason"];
    } & CredentialSettingsContent)
  | {
      readonly status: "error";
      readonly kind: "load";
      readonly announcement: string;
      readonly recoveryAvailable: boolean;
      readonly focus: CredentialSettingsFocus;
    };

export interface CredentialSettingsView {
  bind(handlers: {
    readonly onRetry: () => void;
    readonly onRequestDelete: (credential: DesktopCredentialId) => void;
    readonly onCancelDelete: () => void;
    readonly onConfirmDelete: () => void;
    readonly onOpenSetup: () => void;
  }): void;
  render(state: Exclude<CredentialSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface CredentialSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): CredentialSettingsState;
  dispose(): void;
}

const PROVIDER_NAMES: Readonly<Record<DesktopCredentialId, string>> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  kimi: "Kimi",
  zai: "Z.AI",
  "openai-codex": "ChatGPT",
  "intervals-icu": "intervals.icu",
};

const CREDENTIAL_ORDER: readonly DesktopCredentialId[] = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
  "intervals-icu",
];

function kind(credential: DesktopCredentialId): CredentialKind {
  if (credential === "openai-codex") return "ChatGPT profile";
  if (credential === "intervals-icu") return "Training account key";
  return "Provider API key";
}

function entriesFrom(
  statuses: readonly CredentialSlotStatus[],
  chatGpt: ChatGptStatus,
  runtime: RuntimeConfigSnapshot,
): readonly CredentialSettingsEntry[] {
  const entries = new Map<DesktopCredentialId, CredentialSettingsEntry>();
  for (const status of statuses) {
    if (status.state === "missing") continue;
    const runtimeActive =
      status.slot === "intervals-icu"
        ? runtime.intervals.credential_configured
        : runtime.llm.credential_configured && runtime.llm.provider === status.slot;
    entries.set(status.slot, {
      credential: status.slot,
      provider: PROVIDER_NAMES[status.slot],
      kind: kind(status.slot),
      runtimeState: runtimeActive
        ? "active"
        : status.state === "re-prompt" || status.runtimeState === "failed"
          ? "failed"
          : "stored-inactive",
    });
  }
  if (chatGpt.state === "configured") {
    entries.set("openai-codex", {
      credential: "openai-codex",
      provider: PROVIDER_NAMES["openai-codex"],
      kind: kind("openai-codex"),
      runtimeState: chatGpt.runtimeReady ? "active" : "stored-inactive",
    });
  }
  if (runtime.llm.credential_configured && !entries.has(runtime.llm.provider)) {
    const credential = runtime.llm.provider satisfies DesktopCredentialId;
    entries.set(credential, {
      credential,
      provider: PROVIDER_NAMES[credential],
      kind: kind(credential),
      runtimeState: "active",
    });
  }
  if (runtime.intervals.credential_configured && !entries.has("intervals-icu")) {
    entries.set("intervals-icu", {
      credential: "intervals-icu",
      provider: PROVIDER_NAMES["intervals-icu"],
      kind: kind("intervals-icu"),
      runtimeState: "active",
    });
  }
  return CREDENTIAL_ORDER.flatMap((credential) => {
    const entry = entries.get(credential);
    return entry === undefined ? [] : [entry];
  });
}

function refusalCopy(
  reason: Extract<CredentialDeleteResult, { readonly status: "refused" }>["reason"],
): string {
  if (reason === "managed-by-environment") {
    return "This credential is managed outside Settings and can’t be deleted here.";
  }
  if (reason === "not-found") {
    return "That credential is no longer stored. Reload to refresh the list.";
  }
  if (reason === "storage-failed") {
    return "The credential remains stored. No deletion was completed. Try again.";
  }
  if (reason === "runtime-state-diverged") {
    return "The saved and active credential states could not be reconciled. Reconnect and reload before trying again.";
  }
  return "The coach could not stop using this credential safely. It was not deleted.";
}

export function createCredentialSettingsController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly loadStatuses: () => Promise<readonly CredentialSlotStatus[]>;
  readonly loadChatGptStatus: () => Promise<ChatGptStatus>;
  readonly deleteCredential: (input: {
    readonly credential: DesktopCredentialId;
  }) => Promise<CredentialDeleteResult>;
  readonly openSetup: () => void;
  readonly beginMutation: () => (() => void) | null;
  readonly view: CredentialSettingsView;
}): CredentialSettingsController {
  let currentState: CredentialSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let operation: Promise<void> | undefined;
  let reconnectRequired = false;
  let failedClient: CoachClient | undefined;

  const render = (state: Exclude<CredentialSettingsState, { readonly status: "closed" }>): void => {
    currentState = state;
    input.view.render(state);
  };

  const runtimeClient = async (): Promise<CoachClient> => {
    if (!reconnectRequired) return input.clients.getClient();
    const current = await input.clients.getClient();
    const client =
      failedClient !== undefined && current === failedClient
        ? await input.clients.reconnect()
        : current;
    reconnectRequired = false;
    failedClient = undefined;
    return client;
  };

  const loadEntries = async (): Promise<readonly CredentialSettingsEntry[]> => {
    const client = await runtimeClient();
    try {
      const [statuses, chatGpt, runtime] = await Promise.all([
        input.loadStatuses(),
        input.loadChatGptStatus(),
        client.call("getRuntimeConfig", {}),
      ]);
      return entriesFrom(statuses, chatGpt, runtime);
    } catch (error) {
      if (error instanceof CoachClientDisconnectedError) {
        reconnectRequired = true;
        failedClient = client;
      }
      throw error;
    }
  };

  const startLoad = (): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const operationGeneration = ++generation;
    render({ status: "loading" });
    const pending = loadEntries()
      .then(
        (entries) => {
          if (disposed || generation !== operationGeneration) return;
          render({
            status: "ready",
            entries,
            confirmation: null,
            announcement: "",
            recoveryAvailable: false,
            focus: null,
          });
        },
        () => {
          if (disposed || generation !== operationGeneration) return;
          render({
            status: "error",
            kind: "load",
            announcement: "Saved credentials aren’t available. Reconnect and reload.",
            recoveryAvailable: false,
            focus: null,
          });
        },
      )
      .finally(() => {
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  const contentState = (): CredentialSettingsContent | null => {
    if (
      currentState.status === "ready" ||
      currentState.status === "confirming" ||
      currentState.status === "deleting" ||
      currentState.status === "deleted" ||
      (currentState.status === "error" && currentState.kind === "delete")
    ) {
      return currentState;
    }
    return null;
  };

  const requestDelete = (credential: DesktopCredentialId): void => {
    if (disposed || operation !== undefined) return;
    const content = contentState();
    if (content === null || !content.entries.some((entry) => entry.credential === credential)) {
      return;
    }
    render({
      status: "confirming",
      entries: content.entries,
      confirmation: credential,
      announcement: `Confirm deletion of the ${PROVIDER_NAMES[credential]} credential.`,
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "confirmation-cancel" },
    });
  };

  const cancelDelete = (): void => {
    if (disposed || operation !== undefined) return;
    const content = contentState();
    if (content === null || content.confirmation === null) return;
    const credential = content.confirmation;
    render({
      status: "ready",
      entries: content.entries,
      confirmation: null,
      announcement: "Credential deletion cancelled.",
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "delete", credential },
    });
  };

  const confirmDelete = (): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const content = contentState();
    if (content === null || content.confirmation === null) return Promise.resolve();
    const target = content.entries.find((entry) => entry.credential === content.confirmation);
    if (target === undefined) return Promise.resolve();
    const releaseMutation = input.beginMutation();
    if (releaseMutation === null) return Promise.resolve();
    const credential = target.credential;
    const operationGeneration = ++generation;
    render({
      status: "deleting",
      entries: content.entries,
      confirmation: credential,
      announcement: `Deleting the ${target.provider} credential locally…`,
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "confirmation-delete" },
    });
    const pending = input
      .deleteCredential({ credential })
      .then(async (result) => {
        let entries = content.entries;
        let refreshFailed = false;
        try {
          entries = await loadEntries();
        } catch {
          refreshFailed = true;
          if (result.status === "deleted") {
            entries = entries.filter((entry) => entry.credential !== credential);
          }
        }
        if (disposed || generation !== operationGeneration) return;
        if (result.status === "refused") {
          render({
            status: "error",
            kind: "delete",
            reason: result.reason,
            entries,
            confirmation: null,
            announcement: refusalCopy(result.reason),
            recoveryAvailable:
              content.recoveryAvailable || result.reason === "runtime-state-diverged",
            focus: { target: "delete", credential },
          });
          return;
        }
        const recoveryAvailable = content.recoveryAvailable || target.runtimeState === "active";
        const nextDelete = entries[0]?.credential;
        render({
          status: "deleted",
          entries,
          confirmation: null,
          announcement: result.cleanupPending
            ? "Credential deleted locally. Secure storage cleanup will be retried."
            : refreshFailed
              ? "Credential deleted locally. Current credential status couldn’t be refreshed."
              : "Credential deleted locally.",
          recoveryAvailable,
          focus: recoveryAvailable
            ? { target: "setup" }
            : nextDelete === undefined
              ? null
              : { target: "delete", credential: nextDelete },
        });
      })
      .catch(() => {
        if (disposed || generation !== operationGeneration) return;
        render({
          status: "error",
          kind: "delete",
          reason: "runtime-unavailable",
          entries: content.entries,
          confirmation: null,
          announcement:
            "The credential state could not be confirmed. Reconnect and reload before trying again.",
          recoveryAvailable: content.recoveryAvailable,
          focus: { target: "delete", credential },
        });
      })
      .finally(() => {
        releaseMutation();
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  const openSetup = (): void => {
    const content = contentState();
    if (disposed || operation !== undefined || content?.recoveryAvailable !== true) return;
    currentState = { status: "closed" };
    input.openSetup();
  };

  const close = (): void => {
    if (disposed) return;
    ++generation;
    operation = undefined;
    currentState = { status: "closed" };
  };

  input.view.bind({
    onRetry: () => void startLoad(),
    onRequestDelete: requestDelete,
    onCancelDelete: cancelDelete,
    onConfirmDelete: () => void confirmDelete(),
    onOpenSetup: openSetup,
  });

  return {
    activate() {
      if (disposed) return Promise.resolve();
      if (currentState.status !== "closed") return operation ?? Promise.resolve();
      return startLoad();
    },
    close,
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      operation = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
