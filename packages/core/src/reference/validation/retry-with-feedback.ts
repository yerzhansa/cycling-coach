/**
 * Reference layer — Layer-2 retry orchestrator.
 *
 * Validates one coaching reply against the latest snapshot and, in enforce
 * mode, retries the LLM exactly once with the failure quoted back as feedback.
 * The retry cap is HARD: at most one regeneration, never a loop. Mode-aware
 * (off / observe / enforce). The audit write is the caller's concern; this
 * module only returns flags. Ports from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */
import type { LLM } from "../../llm.js";
import type { LatestJson } from "../schemas/latest.js";
import {
  validateRecommendation,
  parseMetaBlock,
  type Layer2Mode,
} from "./validate-response.js";
import {
  RecommendationMetadataSchema,
  type RecommendationMetadata,
} from "./recommendation-metadata.js";

export interface RetryOpts {
  mode: Layer2Mode;
  snapshot: LatestJson;
  systemPrompt?: string;
}

export interface RetryResult {
  response: string;
  metadata: RecommendationMetadata | null;
  validation_warning?: boolean;
  would_have_retried?: boolean;
}

function parseMetadata(metadata: unknown): RecommendationMetadata | null {
  return RecommendationMetadataSchema.safeParse(metadata).data ?? null;
}

export async function validateAndRetry(
  llm: Pick<LLM, "generate">,
  _originalUserPrompt: string,
  response: string,
  metadata: unknown,
  opts: RetryOpts,
): Promise<RetryResult> {
  if (opts.mode === "off") {
    return { response, metadata: parseMetadata(metadata) };
  }

  const first = validateRecommendation(response, metadata, opts.snapshot);

  if (opts.mode === "observe") {
    return {
      response,
      metadata: parseMetadata(metadata),
      would_have_retried: !first.ok,
    };
  }

  // enforce
  if (first.ok) {
    return { response, metadata: parseMetadata(metadata) };
  }

  const feedback = first.failures.map((f) => f.detail).join("\n- ");
  const retryPrompt = `Your previous response had a citation mismatch:
- ${feedback}
Please regenerate your reply, citing only values that exist in the latest snapshot. Same coaching content, corrected numbers.`;

  const result = await llm.generate({
    system: opts.systemPrompt,
    prompt: retryPrompt,
  });
  const retryText = result.text;

  const retryBlock = parseMetaBlock(retryText);
  const retryMeta = retryBlock?.metadataJson;
  // Second validation is FINAL — the cap is one retry, no loop back here.
  const second = validateRecommendation(retryText, retryMeta, opts.snapshot);

  return {
    response: retryText,
    metadata: parseMetadata(retryMeta),
    validation_warning: second.ok ? undefined : true,
  };
}
