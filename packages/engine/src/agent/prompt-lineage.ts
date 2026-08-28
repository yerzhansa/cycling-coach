import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

// Version of the persisted text-only prompt-lineage contract. Native-media
// prompts use the v3 recipe below because binary leaves require normalization.
// An absent stamp on a stored line means "pre-contract", not "0".
export const PROMPT_LINEAGE_SCHEMA_VERSION = "2";
export const PROMPT_LINEAGE_NATIVE_MEDIA_SCHEMA_VERSION = "3";

export function sha256_16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface PromptTemplateInput {
  soul: string;
  skills: Record<string, string>;
  ruleBlocks: string[];
  toolSchemas: unknown;
  model: string;
}

export interface PromptLineageInput extends PromptTemplateInput {
  systemPrompt: string;
  messages: ModelMessage[];
}

export interface PromptLineage {
  templateHash: string;
  assembledHash: string;
}

function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSerialize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = stableSerialize(record[key]);
    }
    return sorted;
  }
  return value;
}

function binaryDigest(value: ArrayBuffer | ArrayBufferView): {
  readonly binaryByteLength: number;
  readonly binarySha256: string;
} {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return {
    binaryByteLength: bytes.byteLength,
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function nativeImageBytes(value: unknown): ArrayBuffer | ArrayBufferView | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const part = value as Record<string, unknown>;
  if (part.type !== "image") return undefined;
  return part.image instanceof ArrayBuffer || ArrayBuffer.isView(part.image)
    ? part.image
    : undefined;
}

function normalizeNativeMediaMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      const bytes = nativeImageBytes(part);
      if (bytes === undefined) return part;
      changed = true;
      return { ...(part as unknown as Record<string, unknown>), image: binaryDigest(bytes) };
    });
    return changed ? ({ ...message, content } as ModelMessage) : message;
  });
}

export function promptLineageSchemaVersion(messages: ModelMessage[]): string {
  return messages.some(
    (message) => Array.isArray(message.content) && message.content.some(nativeImageBytes),
  )
    ? PROMPT_LINEAGE_NATIVE_MEDIA_SCHEMA_VERSION
    : PROMPT_LINEAGE_SCHEMA_VERSION;
}

export function computeTemplateHash(input: PromptTemplateInput): string {
  const templateBasis = JSON.stringify({
    soul: input.soul,
    skills: stableSerialize(input.skills),
    ruleBlocks: input.ruleBlocks,
    toolSchemas: stableSerialize(input.toolSchemas),
    model: input.model,
  });
  return sha256_16(templateBasis);
}

export function computeAssembledHash(systemPrompt: string, messages: ModelMessage[]): string {
  const assembledBasis = JSON.stringify({
    system: systemPrompt,
    messages: normalizeNativeMediaMessages(messages),
  });
  return sha256_16(assembledBasis);
}

export function computePromptLineage(input: PromptLineageInput): PromptLineage {
  return {
    templateHash: computeTemplateHash(input),
    assembledHash: computeAssembledHash(input.systemPrompt, input.messages),
  };
}
