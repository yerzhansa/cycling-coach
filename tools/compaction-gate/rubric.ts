export const JUDGE_MODEL_ID = "claude-sonnet-4-6";
export const JUDGE_RUNS_PER_TRANSCRIPT = 3;
// The summarizer samples: a single draw can embellish one detail the next
// draw would not. The gate certifies TYPICAL behavior — each transcript is
// summarized this many times and the Tier-J verdict is the majority over
// draws. MUST-PRESERVE stays strict across every draw.
export const SUMMARY_DRAWS_PER_TRANSCRIPT = 3;
export const TIER_J_FACT_THRESHOLD = 0.9;
export const TIER_J_MAX_FABRICATIONS = 0;
export const JUDGE_MAX_OUTPUT_TOKENS = 2_000;

export const JUDGE_RUBRIC = `You are a strict evaluation judge for conversation summaries produced by an endurance-coaching assistant. You will receive a JSON payload with three fields: "transcript" (the full conversation that was summarized, as role-prefixed lines, possibly preceded by an earlier summary labeled EXISTING SUMMARY), "facts" (an array of objects with "id" and "statement" - the inventory of facts planted in that conversation), and "summary" (the summary under evaluation).

Evaluate ONLY the following, exactly as specified:

1. For EACH fact in "facts", decide whether the summary preserves it. A fact is PRESERVED when a reader of the summary alone would learn the same specific information, with every number, date, and unit exactly matching the statement. Paraphrase is acceptable; changed, rounded, or dropped numbers are not. A fact that is partially present with any numeric or date alteration counts as MISSING.
2. List FABRICATIONS: any specific factual claim in the summary - a number, date, event, injury, equipment item, stated goal, or attributed position - that is not derivable from the transcript (including its EXISTING SUMMARY section, when present). General restructuring language and the five section headings are never fabrications. Judgment calls that merely re-order or group facts are not fabrications.

Reply with ONLY a JSON object, no prose before or after, in exactly this shape:
{"factsPreserved": ["<id>", ...], "factsMissing": ["<id>", ...], "fabrications": ["<short description>", ...]}

Every fact id from the payload must appear in exactly one of factsPreserved or factsMissing.`;
