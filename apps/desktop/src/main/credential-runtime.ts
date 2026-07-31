import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import {
  type ConfigureRuntimeRpcParams,
  type LlmProvider,
  type RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import { CHATGPT_PROFILE_NAME } from "./chatgpt-auth.js";
import type { CredentialRuntimeState, DesktopCredentialSlot } from "./credential-vault.js";
import { runtimeConfigurationForCredential } from "./onboarding-ipc.js";

export type DesktopManagedCredential = DesktopCredentialSlot | typeof CHATGPT_PROFILE_NAME;

export interface LlmProviderSelectionEvidence {
  readonly chatGptProfilePresent: boolean;
  readonly storedCredentialSlots: readonly DesktopCredentialSlot[];
}

export interface CredentialRuntimeApplication {
  applyExplicit(request: ConfigureRuntimeRpcParams): Promise<void>;
  applyExistingLlmSelection(
    provider: LlmProvider,
    request: ConfigureRuntimeRpcParams,
  ): Promise<boolean>;
  reapplyStoredCredential(
    slot: DesktopCredentialSlot,
    value: string,
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ): Promise<Exclude<CredentialRuntimeState, "failed">>;
  clearCredential(
    credential: DesktopManagedCredential,
  ): Promise<"cleared" | "not-active" | "managed-by-environment">;
}

interface CredentialRuntimeApplicationOptions {
  readonly selectedLlmProvider: (
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ) => Promise<LlmProvider | undefined>;
  readonly configureRuntime: (request: ConfigureRuntimeRpcParams) => Promise<void>;
  readonly clearRuntimeCredential?: (
    credential: DesktopManagedCredential,
  ) => Promise<"cleared" | "not-active" | "managed-by-environment">;
}

export interface RuntimeConfigurationAuthority {
  configureRuntime(request: ConfigureRuntimeRpcParams): Promise<void>;
  clearCredential(
    credential: DesktopManagedCredential,
  ): Promise<"cleared" | "not-active" | "managed-by-environment">;
  getRuntimeConfig(): Promise<RuntimeConfigSnapshot>;
}

export function runtimeConfigurationForCredentialDeletion(
  credential: DesktopManagedCredential,
): ConfigureRuntimeRpcParams {
  return credential === "intervals-icu"
    ? { intervals: { clear_credential: true } }
    : { llm: { provider: credential, clear_credential: true } };
}

export function intervalsAthleteIdForOwnership(snapshot: RuntimeConfigSnapshot): string {
  return snapshot.intervals.athlete_id === "" ? "0" : snapshot.intervals.athlete_id;
}

export function readSelectedLlmProvider(
  snapshot: RuntimeConfigSnapshot,
  evidence: LlmProviderSelectionEvidence,
): LlmProvider | undefined {
  const provider = snapshot.llm.provider;
  if (snapshot.llm.credential_configured) return provider;
  if (provider === CHATGPT_PROFILE_NAME) {
    return evidence.chatGptProfilePresent ? provider : undefined;
  }
  return evidence.storedCredentialSlots.includes(provider) ? provider : undefined;
}

export function createConnectionRuntimeAuthority(
  connection: Readonly<{ url: `ws://127.0.0.1:${number}/rpc`; token: string }>,
  connect: typeof connectCoachClient = connectCoachClient,
): RuntimeConfigurationAuthority {
  const call = async <T>(operation: (client: CoachClient) => Promise<T>): Promise<T> => {
    const client = await connect({ url: connection.url, token: connection.token });
    try {
      return (await operation(client)) as T;
    } finally {
      await client.close();
    }
  };
  return {
    async configureRuntime(request) {
      const result = await call((client) => client.call("configureRuntime", request));
      if (
        !("status" in result) ||
        result.status !== "applied" ||
        (request.llm !== undefined && !result.applied.llm) ||
        (request.intervals !== undefined && !result.applied.intervals) ||
        (request.session !== undefined && !result.applied.session)
      ) {
        throw new TypeError();
      }
    },
    async clearCredential(credential) {
      const request = runtimeConfigurationForCredentialDeletion(credential);
      const result = await call((client) => client.call("configureRuntime", request));
      if ("status" in result && result.status === "refused") {
        if (result.reason === "managed-by-environment") return "managed-by-environment";
        if (result.reason === "credential-required") return "not-active";
        throw new TypeError();
      }
      if (
        !("status" in result) ||
        result.status !== "applied" ||
        result.applied.llm !== (request.llm !== undefined) ||
        result.applied.intervals !== (request.intervals !== undefined) ||
        result.applied.session
      ) {
        throw new TypeError();
      }
      return "cleared";
    },
    getRuntimeConfig() {
      return call((client) => client.call("getRuntimeConfig", {}));
    },
  };
}

export function createCredentialRuntimeApplication(
  options: CredentialRuntimeApplicationOptions,
): CredentialRuntimeApplication {
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    applyExplicit(request) {
      return serialize(() => options.configureRuntime(request));
    },
    applyExistingLlmSelection(provider, request) {
      return serialize(async () => {
        if (request.llm === undefined || request.llm.provider !== undefined) throw new TypeError();
        const selectedProvider = await options.selectedLlmProvider([]);
        if (selectedProvider !== provider) return false;
        await options.configureRuntime(request);
        return true;
      });
    },
    reapplyStoredCredential(slot, value, storedCredentialSlots) {
      return serialize(async () => {
        const request = runtimeConfigurationForCredential(slot, value);
        const selectedProvider = await options.selectedLlmProvider(storedCredentialSlots);
        if (request.llm !== undefined && selectedProvider !== undefined) {
          if (selectedProvider !== request.llm.provider) return "stored-inactive";
        }
        await options.configureRuntime(request);
        return "active";
      });
    },
    clearCredential(credential) {
      return serialize(() => {
        if (options.clearRuntimeCredential === undefined) throw new TypeError();
        return options.clearRuntimeCredential(credential);
      });
    },
  };
}
