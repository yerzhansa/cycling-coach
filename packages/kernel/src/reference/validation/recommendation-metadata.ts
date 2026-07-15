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

export const AUDIT_SCHEMA_VERSION = "2";

/**
 * Event-type discriminator for an audit entry. `turn_failed` is the reserved
 * terminal-failure class: a turn that never delivered a reply, so the offline
 * gate can correct for survivorship rather than modelling delivered replies
 * only. The per-turn outcome record is emitted to a separate diagnostic sink;
 * this member reserves the class on the entry for the later chat-path wiring.
 */
export const AuditEventType = z.enum([
  "reply",
  "tool_gate_block",
  "input_screen_hit",
  "refusal",
  "turn_failed",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const LensVerdictSchema = z
  .object({ lens: z.string(), ok: z.boolean(), detail: z.string().nullable() })
  .strict();
export type LensVerdict = z.infer<typeof LensVerdictSchema>;

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
    // v2 fields — all optional/nullable so a v1-shaped line still parses under
    // .strict() once the parser maps it forward.
    event_type: AuditEventType.optional(),
    verdicts: z.array(LensVerdictSchema).nullable().optional(),
    prompt_template_hash: z.string().nullable().optional(),
  })
  .strict();
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
