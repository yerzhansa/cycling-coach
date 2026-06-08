/**
 * Reference layer — recommendation metadata + audit-log line schemas.
 *
 * `RecommendationMetadata` is the structured contract every Reference-era
 * coaching reply carries (citations, confidence, frameworks, phase tag);
 * Layer 2 enforces it. `AuditLogEntry` is the `.audit.jsonl` line shape the
 * writer persists. These shapes port from the Reference layer's upstream
 * protocol. See `NOTICE.md` for license attribution.
 */
import { z } from "zod";

export const AUDIT_SCHEMA_VERSION = "1";

export const CitationSchema = z
  .object({
    field: z.string(),
    value: z.unknown(),
    source: z.literal("latest.json"),
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

export const RecommendationMetadataSchema = z
  .object({
    citations: z.array(CitationSchema),
    confidence: z.enum(["high", "medium", "low"]),
    frameworks: z.array(z.string()).min(1),
    phase_tag: z.string(),
  })
  .strict();
export type RecommendationMetadata = z.infer<typeof RecommendationMetadataSchema>;

export const AuditLogEntrySchema = z
  .object({
    schema_version: z.string(),
    ts: z.string(),
    chatId: z.string(),
    responseHash: z.string(),
    metadata: RecommendationMetadataSchema,
    validation_warning: z.boolean().optional(),
  })
  .strict();
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
