import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ConfigureRuntimeRpcParams,
  type LlmProvider,
  LlmProviderSchema,
} from "@enduragent/coach-contract";
import { parse as parseYaml } from "yaml";
import { CHATGPT_PROFILE_NAME } from "./chatgpt-auth.js";
import type { CredentialRuntimeState, DesktopCredentialSlot } from "./credential-vault.js";
import { runtimeConfigurationForCredential } from "./onboarding-ipc.js";

export interface LlmProviderSelectionEvidence {
  readonly chatGptProfilePresent: boolean;
  readonly storedCredentialSlots: readonly DesktopCredentialSlot[];
}

export interface CredentialRuntimeApplication {
  applyExplicit(request: ConfigureRuntimeRpcParams): Promise<void>;
  reapplyStoredCredential(
    slot: DesktopCredentialSlot,
    value: string,
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ): Promise<Exclude<CredentialRuntimeState, "failed">>;
}

interface CredentialRuntimeApplicationOptions {
  readonly selectedLlmProvider: (
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ) => Promise<LlmProvider | undefined>;
  readonly configureRuntime: (request: ConfigureRuntimeRpcParams) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readSelectedLlmProvider(
  configDir: string,
  evidence: LlmProviderSelectionEvidence,
): Promise<LlmProvider | undefined> {
  let source: string;
  try {
    source = await readFile(join(configDir, "config.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = parseYaml(source) as unknown;
  if (parsed === undefined || parsed === null) return undefined;
  if (!isRecord(parsed)) throw new TypeError();
  if (parsed.llm === undefined) return undefined;
  if (!isRecord(parsed.llm)) throw new TypeError();
  if (parsed.llm.provider === undefined) return undefined;
  const provider = LlmProviderSchema.parse(parsed.llm.provider);
  if (provider === CHATGPT_PROFILE_NAME) {
    return evidence.chatGptProfilePresent ? provider : undefined;
  }
  return evidence.storedCredentialSlots.includes(provider) ? provider : undefined;
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
  };
}
