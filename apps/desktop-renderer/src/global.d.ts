interface EnduragentAuth {
  getDaemonConnection(failedGeneration?: number): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly token: string;
    readonly generation: number;
  }>;
  getTranscriptPage(input: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<DesktopTranscriptPage>;
  listArchivedConversations(): Promise<DesktopArchivedConversationList>;
  getArchivedTranscriptPage(input: {
    readonly boundaryRef: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<DesktopTranscriptPage>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: {
    readonly slot: DesktopCredentialSlot;
    readonly value: string;
    readonly selection?: OnboardingLlmSelection;
  }): Promise<CredentialWriteResult>;
  deleteCredential(input: {
    readonly credential: DesktopCredentialId;
  }): Promise<CredentialDeleteResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(input: OnboardingLlmSelection): Promise<ChatGptLoginResult>;
  claudeCliStatus(): Promise<ClaudeCliStatus>;
  claudeCliRecheck(): Promise<ClaudeCliStatus>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
  releaseNotes(): Promise<ReleaseNotesResult>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  restartToUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

interface DesktopTranscriptTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

interface DesktopArchivedConversationSummary {
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly reason: "explicit-reset" | "stale-reset";
  readonly turnCount: number;
}

interface DesktopArchivedConversationList {
  readonly schemaVersion: 1;
  readonly conversations: readonly DesktopArchivedConversationSummary[];
  readonly truncated: boolean;
}

type DesktopTranscriptPage =
  | {
      readonly schemaVersion: 1;
      readonly status: "page";
      readonly turns: readonly DesktopTranscriptTurn[];
      readonly nextCursor: string | null;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "restart-required";
      readonly turns: readonly [];
      readonly nextCursor: null;
    };

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

type DesktopCredentialId = DesktopCredentialSlot | "openai-codex";

type LlmProvider =
  | Exclude<DesktopCredentialSlot, "intervals-icu">
  | "openai-codex"
  | "claude-cli"
  | "codex-agent";

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

type ClaudeCliState =
  | "absent-binary"
  | "not-logged-in"
  | "api-key-token"
  | "ready"
  | "ready-api-key"
  | "disabled";

interface ClaudeCliStatus {
  readonly state: ClaudeCliState;
  readonly email?: string;
  readonly plan?: string;
  readonly version?: string;
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

type CredentialDeleteResult =
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

interface Window {
  readonly enduragentAuth: EnduragentAuth;
}

interface WindowEventMap {
  readonly "enduragent-lifecycle": CustomEvent<{
    readonly status: "ready" | "recovering" | "terminal" | "closing";
    readonly generation: number;
  }>;
}

declare const __ENDURAGENT_APP_VERSION__: string;

declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module "*.css" {}
