import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

function sha256_16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface PromptLineageInput {
  soul: string;
  skills: Record<string, string>;
  ruleBlocks: string[];
  toolSchemas: unknown;
  model: string;
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

export function computePromptLineage(input: PromptLineageInput): PromptLineage {
  const templateBasis = JSON.stringify({
    soul: input.soul,
    skills: stableSerialize(input.skills),
    ruleBlocks: input.ruleBlocks,
    toolSchemas: stableSerialize(input.toolSchemas),
    model: input.model,
  });
  const assembledBasis = JSON.stringify({
    system: input.systemPrompt,
    messages: input.messages,
  });
  return {
    templateHash: sha256_16(templateBasis),
    assembledHash: sha256_16(assembledBasis),
  };
}
