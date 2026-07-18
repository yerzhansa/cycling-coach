import { z } from "zod";

/** Engine-internal turn failure classification (frozen field vocabulary). */
export const TurnErrorClassSchema = z.enum([
  "budget",
  "overflow",
  "timeout",
  "rate_limit",
  "unknown",
]);
export type TurnErrorClass = z.infer<typeof TurnErrorClassSchema>;

/** Athlete-facing error classification, paired with displayable copy. */
export const AgentErrorKindSchema = z.enum([
  "rate_limit",
  "provider-auth",
  "provider-down",
  "intervals",
  "unknown",
  "detached",
]);
export type AgentErrorKind = z.infer<typeof AgentErrorKindSchema>;

export const TurnStartEventSchema = z
  .object({
    type: z.literal("turn-start"),
    turnId: z.string(),
    chatId: z.string(),
  })
  .strict();

export const ToolStartEventSchema = z
  .object({
    type: z.literal("tool-start"),
    turnId: z.string(),
    toolName: z.string(),
  })
  .strict();

export const ToolEndEventSchema = z
  .object({
    type: z.literal("tool-end"),
    turnId: z.string(),
    toolName: z.string(),
    summary: z.string().optional(),
  })
  .strict();

/**
 * Producers may emit zero or more step-text events per turn; consumers must
 * not assume any particular count.
 */
export const StepTextEventSchema = z
  .object({
    type: z.literal("step-text"),
    turnId: z.string(),
    text: z.string(),
  })
  .strict();

export const FinalTextEventSchema = z
  .object({
    type: z.literal("final-text"),
    turnId: z.string(),
    text: z.string(),
  })
  .strict();

export const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    turnId: z.string(),
    chatId: z.string(),
    error_class: TurnErrorClassSchema,
    kind: AgentErrorKindSchema,
    athleteMessage: z.string(),
    overflowAttempts: z.number(),
    timeoutAttempts: z.number(),
    rateLimitAttempts: z.number(),
    duration_ms: z.number(),
    compactions: z.number(),
  })
  .strict();

/**
 * Reserved for a future streaming producer. Nothing emits this variant today;
 * consumers must tolerate never receiving it.
 */
export const TextDeltaEventSchema = z
  .object({
    type: z.literal("text_delta"),
    turnId: z.string(),
    delta: z.string(),
  })
  .strict();

/**
 * Terminal shapes: a successful turn ends with `final-text` as its last event.
 * A failed turn with no committed writes ends with `error` and delivers no
 * final text. A turn that fails AFTER a committed write emits `error` and THEN
 * `final-text` carrying the delivered fallback copy — the two co-occur, in
 * that order.
 */
export const TurnEventSchema = z.discriminatedUnion("type", [
  TurnStartEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  StepTextEventSchema,
  FinalTextEventSchema,
  ErrorEventSchema,
  TextDeltaEventSchema,
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

/**
 * Events are advisory; a consumer callback throwing must never affect the
 * turn.
 */
export type TurnEventHandler = (event: TurnEvent) => void;
