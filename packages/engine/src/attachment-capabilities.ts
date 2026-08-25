import {
  AttachmentCapabilitiesReadModelSchema,
  isKeylessProvider,
  type AttachmentCapabilitiesReadModel,
} from "@enduragent/coach-contract";
import type { EngineLlmProvider } from "./host-ports.js";
import {
  resolveOpenRouterModelMetadata,
  type OpenRouterModelMetadataCache,
  type OpenRouterModelMetadataSnapshot,
} from "./openrouter-model-metadata.js";

export type NativeMediaTransport = "ai-sdk" | "openai-codex" | "claude-cli" | "codex-agent";

export interface ActiveAttachmentModel {
  readonly provider: EngineLlmProvider;
  readonly model: string;
  readonly transport: NativeMediaTransport;
  readonly apiKey?: string;
}

export interface AttachmentCapabilityResolver {
  resolve(
    active: ActiveAttachmentModel,
    signal?: AbortSignal,
  ): Promise<AttachmentCapabilitiesReadModel>;
}

export interface AttachmentCapabilityResolverOptions {
  readonly openRouterCache: OpenRouterModelMetadataCache;
  readonly metadataMaxAgeMs: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly openRouterBaseUrl?: string;
}

const KNOWN_IMAGE_MODELS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  anthropic: new Set(["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-5"]),
  openai: new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
  google: new Set(["gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]),
});

const KNOWN_TEXT_ONLY_PROVIDERS = new Set<EngineLlmProvider>([
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
]);

function base(active: ActiveAttachmentModel) {
  return {
    schemaVersion: 1 as const,
    active: {
      provider: active.provider,
      model: active.model,
      transport: active.transport,
    },
    documents: {
      enabled: true as const,
      extensions: ["pdf", "txt", "csv", "docx"] as const,
    },
    completedActivities: {
      enabled: true as const,
      extensions: ["fit", "tcx", "gpx"] as const,
    },
    plannedWorkouts: {
      enabled: true as const,
      extensions: ["zwo", "erg", "mrc"] as const,
    },
  };
}

function checkedAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function enabled(
  active: ActiveAttachmentModel,
  source: "maintained_catalogue" | "provider_metadata",
  epochMs: number,
): AttachmentCapabilitiesReadModel {
  return AttachmentCapabilitiesReadModelSchema.parse({
    ...base(active),
    images: {
      enabled: true,
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
      reason: "supported",
      source,
      checkedAt: checkedAt(epochMs),
    },
  });
}

function disabled(
  active: ActiveAttachmentModel,
  reason: AttachmentCapabilitiesReadModel["images"] extends infer Images
    ? Images extends { readonly enabled: false; readonly reason: infer Reason }
      ? Reason
      : never
    : never,
  source: "maintained_catalogue" | "provider_metadata" | "unknown" | "transport_blocked",
  epochMs: number,
): AttachmentCapabilitiesReadModel {
  return AttachmentCapabilitiesReadModelSchema.parse({
    ...base(active),
    images: { enabled: false, mediaTypes: [], reason, source, checkedAt: checkedAt(epochMs) },
  });
}

export function transportForProvider(provider: EngineLlmProvider): NativeMediaTransport {
  if (isKeylessProvider(provider)) return provider;
  return "ai-sdk";
}

export function resolveAttachmentCapabilities(input: {
  readonly active: ActiveAttachmentModel;
  readonly nowMs: number;
  readonly metadataMaxAgeMs: number;
  readonly openRouterMetadata?: OpenRouterModelMetadataSnapshot;
}): AttachmentCapabilitiesReadModel {
  const { active, nowMs } = input;
  if (active.transport !== "ai-sdk") {
    return disabled(active, "transport_incompatible", "transport_blocked", nowMs);
  }
  if (active.provider === "openrouter") {
    const metadata = input.openRouterMetadata;
    if (metadata === undefined || metadata.modelId !== active.model) {
      return disabled(active, "unknown_model", "unknown", nowMs);
    }
    if (metadata.fetchedAtMs > nowMs || nowMs - metadata.fetchedAtMs > input.metadataMaxAgeMs) {
      return disabled(active, "metadata_stale", "provider_metadata", metadata.fetchedAtMs);
    }
    return metadata.inputModalities.includes("image")
      ? enabled(active, "provider_metadata", metadata.fetchedAtMs)
      : disabled(active, "model_incompatible", "provider_metadata", metadata.fetchedAtMs);
  }
  const known = KNOWN_IMAGE_MODELS[active.provider];
  if (known?.has(active.model) === true) {
    return enabled(active, "maintained_catalogue", nowMs);
  }
  if (KNOWN_TEXT_ONLY_PROVIDERS.has(active.provider)) {
    return disabled(active, "model_incompatible", "maintained_catalogue", nowMs);
  }
  return disabled(active, "unknown_model", "unknown", nowMs);
}

export function createAttachmentCapabilityResolver(
  options: AttachmentCapabilityResolverOptions,
): AttachmentCapabilityResolver {
  return Object.freeze({
    async resolve(active: ActiveAttachmentModel, signal?: AbortSignal) {
      const now = options.now ?? Date.now;
      const openRouterMetadata =
        active.provider === "openrouter"
          ? await resolveOpenRouterModelMetadata({
              modelId: active.model,
              cache: options.openRouterCache,
              maxAgeMs: options.metadataMaxAgeMs,
              now,
              ...(active.apiKey === undefined ? {} : { apiKey: active.apiKey }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              ...(signal === undefined ? {} : { signal }),
              ...(options.openRouterBaseUrl === undefined
                ? {}
                : { baseUrl: options.openRouterBaseUrl }),
            })
          : undefined;
      return resolveAttachmentCapabilities({
        active,
        nowMs: now(),
        metadataMaxAgeMs: options.metadataMaxAgeMs,
        openRouterMetadata,
      });
    },
  });
}
