import type { CoachClient } from "@enduragent/coach-client";
import { CoachClientDisconnectedError, connectCoachClient } from "@enduragent/coach-client";
import {
  ImportFilesRpcParamsSchema,
  SaveIntakeRpcParamsSchema,
  type CoachOperationProgressNotificationEnvelope,
  type ImportFilesRpcResult,
  type LlmProvider,
  type SaveIntakeRpcParams,
} from "@enduragent/coach-contract";
import { SUPPORTED_IMPORT_EXTENSIONS, type DesktopCredentialSlot } from "./constants.js";
import type { ChatGptLoginResult, ChatGptStatus, CredentialSlotStatus } from "./machine.js";

export type CredentialWriteResult =
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

export type DesktopCredentialId = DesktopCredentialSlot | "openai-codex";

export type CredentialDeleteResult =
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

export interface OnboardingLlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface OnboardingLlmProviderConfiguration {
  readonly provider: LlmProvider;
  readonly defaultModel: string;
  readonly models: readonly OnboardingLlmModelOption[];
  readonly defaultBaseUrl?: string;
}

export interface OnboardingLlmConfiguration {
  readonly schemaVersion: 1;
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: {
    readonly provider: LlmProvider;
    readonly model: string;
  } | null;
}

export type OnboardingLlmEndpointSelection =
  | { readonly mode: "automatic" }
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly value: string };

export interface OnboardingLlmSelection {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly endpoint: OnboardingLlmEndpointSelection;
}

export type OnboardingLlmSelectionResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "refused";
      readonly reason: "invalid-input" | "credential-required" | "runtime-unavailable";
    };

export interface OnboardingCredentialWriteInput {
  readonly slot: DesktopCredentialSlot;
  readonly value: string;
  readonly selection?: OnboardingLlmSelection;
}

export interface OnboardingBridge {
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: OnboardingCredentialWriteInput): Promise<CredentialWriteResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatGptStatus(): Promise<ChatGptStatus>;
  chatGptLogin(input: OnboardingLlmSelection): Promise<ChatGptLoginResult>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
  importFiles(
    paths: readonly string[],
    onProgress: (event: CoachOperationProgressNotificationEnvelope) => void,
  ): Promise<ImportFilesRpcResult>;
  saveIntake(input: SaveIntakeRpcParams): Promise<void>;
}

export interface DesktopOnboardingAuth {
  getDaemonConnection(): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly token: string;
  }>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: OnboardingCredentialWriteInput): Promise<CredentialWriteResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(input: OnboardingLlmSelection): Promise<ChatGptLoginResult>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
}

function extension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

export function validateImportPaths(paths: readonly string[]): readonly string[] {
  const normalized = [...paths];
  if (
    normalized.some(
      (path) =>
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.includes("\0") ||
        !(SUPPORTED_IMPORT_EXTENSIONS as readonly string[]).includes(extension(path)),
    )
  ) {
    throw new TypeError();
  }
  return ImportFilesRpcParamsSchema.parse({ paths: normalized }).paths;
}

export function createOnboardingBridge(
  auth: DesktopOnboardingAuth = (
    window as unknown as Window & { readonly enduragentAuth: DesktopOnboardingAuth }
  ).enduragentAuth,
  connect: typeof connectCoachClient = connectCoachClient,
): OnboardingBridge {
  let clientPromise: Promise<CoachClient> | undefined;
  const client = (): Promise<CoachClient> => {
    if (clientPromise !== undefined) return clientPromise;
    const pending = auth
      .getDaemonConnection()
      .then((connection) => {
        const url = new URL(connection.url);
        if (
          url.protocol !== "ws:" ||
          url.hostname !== "127.0.0.1" ||
          url.port === "" ||
          !/^\d+$/u.test(url.port) ||
          url.pathname !== "/rpc" ||
          url.username !== "" ||
          url.password !== "" ||
          url.search !== "" ||
          url.hash !== "" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(connection.token)
        ) {
          throw new TypeError();
        }
        return connect(connection);
      })
      .catch((error: unknown) => {
        if (clientPromise === pending) clientPromise = undefined;
        throw error;
      });
    clientPromise = pending;
    return pending;
  };
  return {
    credentialStatuses: () => auth.credentialStatuses() as Promise<readonly CredentialSlotStatus[]>,
    retryFailedCredentials: () =>
      auth.retryFailedCredentials() as Promise<readonly CredentialSlotStatus[]>,
    writeCredential: (input) => auth.writeCredential(input) as Promise<CredentialWriteResult>,
    llmConfiguration: () => auth.llmConfiguration(),
    applyLlmSelection: (input) => auth.applyLlmSelection(input),
    chatGptStatus: () => auth.chatgptStatus(),
    chatGptLogin: (input) => auth.chatgptLogin(input),
    chooseImportFiles: () => auth.chooseImportFiles(),
    onDroppedImportFiles: (listener) => auth.onDroppedImportFiles(listener),
    async importFiles(paths, onProgress) {
      const parsedPaths = validateImportPaths(paths);
      const connected = await client();
      try {
        return await connected.call(
          "importFiles",
          { paths: [...parsedPaths] },
          { onNotificationEnvelope: onProgress },
        );
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) clientPromise = undefined;
        throw error;
      }
    },
    async saveIntake(input) {
      const connected = await client();
      try {
        const result = await connected.call("saveIntake", SaveIntakeRpcParamsSchema.parse(input));
        if (!result.saved) throw new TypeError();
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) clientPromise = undefined;
        throw error;
      }
    },
  };
}
