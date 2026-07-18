import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

// Version of the persisted prompt-lineage contract. Bump in the same change as
// ANY edit to a hash basis recipe: template/assembled basis fields,
// stableSerialize normalization, the digest, or the system-prompt assembly
// shape. An absent stamp on a stored line means "pre-contract", not "0".
export const PROMPT_LINEAGE_SCHEMA_VERSION = "2";

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
  const assembledBasis = JSON.stringify({ system: systemPrompt, messages });
  return sha256_16(assembledBasis);
}

export function computePromptLineage(input: PromptLineageInput): PromptLineage {
  return {
    templateHash: computeTemplateHash(input),
    assembledHash: computeAssembledHash(input.systemPrompt, input.messages),
  };
}
