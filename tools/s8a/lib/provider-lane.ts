import { S8A_PROVIDERS, type S8aProvider } from "./types.js";

export interface ProviderLane {
  readonly provider: S8aProvider;
  readonly defaultRecordModel: string;
  readonly recordBypassHosts: readonly string[];
  readonly credential: "api-key" | "oauth-profile";
}

export const PROVIDER_LANES: Readonly<Record<S8aProvider, ProviderLane>> = {
  anthropic: {
    provider: "anthropic",
    defaultRecordModel: "claude-sonnet-4-6",
    recordBypassHosts: ["api.anthropic.com"],
    credential: "api-key",
  },
  "openai-codex": {
    provider: "openai-codex",
    defaultRecordModel: "gpt-5.6-sol",
    recordBypassHosts: ["chatgpt.com", "auth.openai.com"],
    credential: "oauth-profile",
  },
};

export function isS8aProvider(value: unknown): value is S8aProvider {
  return typeof value === "string" && (S8A_PROVIDERS as readonly string[]).includes(value);
}

export function providerLane(provider: S8aProvider): ProviderLane {
  return PROVIDER_LANES[provider];
}

export function supportedProviderList(): string {
  return S8A_PROVIDERS.join(" | ");
}
