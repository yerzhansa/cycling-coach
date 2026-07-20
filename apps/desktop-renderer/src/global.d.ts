interface EnduragentAuth {
  getDaemonConnection(): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly token: string;
  }>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: {
    readonly slot: DesktopCredentialSlot;
    readonly value: string;
  }): Promise<CredentialWriteResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(): Promise<ChatGptLoginResult>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
}

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

type CredentialState = "missing" | "configured" | "re-prompt";

interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeReady: boolean;
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
      readonly runtimeReady: true;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "invalid-input"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed"
        | "runtime-unavailable";
    };

interface Window {
  readonly enduragentAuth: EnduragentAuth;
}

declare module "*.css" {}
