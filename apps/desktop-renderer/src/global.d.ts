interface EnduragentAuth {
  getDaemonConnection(failedGeneration?: number): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly token: string;
    readonly generation: number;
  }>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: {
    readonly slot: DesktopCredentialSlot;
    readonly value: string;
    readonly selection?: OnboardingLlmSelection;
  }): Promise<CredentialWriteResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(input: OnboardingLlmSelection): Promise<ChatGptLoginResult>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
  releaseNotes(): Promise<ReleaseNotesResult>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  restartToUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

type DesktopUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | {
      readonly status: "downloading" | "downloaded" | "installing";
      readonly version: string;
    }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

type ReleaseNotesResult =
  | {
      readonly status: "available";
      readonly version: string;
      readonly notes: readonly string[];
      readonly releaseUrl: string;
    }
  | {
      readonly status: "unavailable";
      readonly version: string | null;
      readonly releaseUrl: string;
    };

type DesktopCredentialSlot =
  | "anthropic"
  | "openrouter"
  | "openai"
  | "google"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "kimi"
  | "zai"
  | "intervals-icu";

type LlmProvider = Exclude<DesktopCredentialSlot, "intervals-icu"> | "openai-codex";

interface OnboardingLlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

interface OnboardingLlmProviderConfiguration {
  readonly provider: LlmProvider;
  readonly defaultModel: string;
  readonly models: readonly OnboardingLlmModelOption[];
  readonly defaultBaseUrl?: string;
}

interface OnboardingLlmConfiguration {
  readonly schemaVersion: 1;
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: {
    readonly provider: LlmProvider;
    readonly model: string;
  } | null;
}

type OnboardingLlmEndpointSelection =
  | { readonly mode: "automatic" }
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly value: string };

interface OnboardingLlmSelection {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly endpoint: OnboardingLlmEndpointSelection;
}

type OnboardingLlmSelectionResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "refused";
      readonly reason: "invalid-input" | "credential-required" | "runtime-unavailable";
    };

type CredentialState = "missing" | "configured" | "re-prompt";
type CredentialRuntimeState = "active" | "stored-inactive" | "failed";

interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

interface ChatGptStatus {
  readonly state: "configured" | "absent";
  readonly runtimeReady: boolean;
}

type ChatGptLoginResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "refused";
      readonly reason:
        | "already-in-progress"
        | "callback-unavailable"
        | "timed-out"
        | "cancelled"
        | "exchange-failed"
        | "storage-failed"
        | "runtime-unavailable";
    };

type CredentialWriteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "configured";
      readonly runtimeReady: boolean;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "invalid-input"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed"
        | "runtime-unavailable"
        | "training-account-mismatch";
    };

interface Window {
  readonly enduragentAuth: EnduragentAuth;
}

interface WindowEventMap {
  readonly "enduragent-lifecycle": CustomEvent<{
    readonly status: "ready" | "recovering" | "terminal" | "closing";
    readonly generation: number;
  }>;
}

declare module "*.css" {}
