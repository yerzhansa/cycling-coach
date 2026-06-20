import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemoryStore, ResolvedCs } from "@enduragent/core";
import type { IntervalsClient } from "intervals-icu-api";
import {
  calculateRunningZones,
  LOWER_FRACTION_CLAMP,
  CS_SANITY_MPS,
  THRESHOLD_DEFINITION,
  type RunningZoneDisplay,
} from "./zones.js";
import {
  serializeRunningWorkout,
  runningWorkoutInputSchema,
  InvalidWorkoutError,
  type RunningWorkoutInput,
} from "./intervals-serializer.js";

/**
 * Pure-Sport running tools per ADR-0004 — the CS-anchored `calculate_zones` tool
 * plus the running-flavored intervals.icu workout creator (hardcoded
 * `type: "Run"`, gated on a configured intervals client). Pure-Core and
 * Core-with-sport-config intervals tools still compose in via `runningSport.tools`.
 *
 * The athlete's critical speed is resolved automatically from synced
 * intervals.icu data when available (`resolvedCs` getter, fed per turn by Core);
 * the LLM-supplied `criticalSpeedMps` is now an override, not a requirement.
 */

const RPE_FRAMING =
  "These paces are RPE-checked estimates from a population-mean model, not " +
  "lab-measured thresholds — if pace and effort disagree, trust effort and adjust. " +
  "The single table carries individual and sex-specific spread; CS is a monitoring " +
  "anchor, not a hold-forever pace.";

function clampLowerFraction(requested: number): { value: number; clamped: boolean } {
  const value = Math.min(LOWER_FRACTION_CLAMP.max, Math.max(LOWER_FRACTION_CLAMP.min, requested));
  return { value, clamped: value !== requested };
}

export function createRunningTools(
  _memory: MemoryStore,
  intervals: IntervalsClient | null,
  _tz: string = "UTC",
  resolvedCs?: () => ResolvedCs | null,
) {
  return {
    calculate_zones: tool({
      description:
        "Calculate 6 critical-speed-anchored running pace zones. When the athlete's " +
        "critical speed is synced from intervals.icu, OMIT criticalSpeedMps — the tool " +
        "uses the synced anchor automatically and reports its provenance. Pass " +
        "criticalSpeedMps (in m/s; intervals.icu stores threshold_pace in SI m/s, e.g. " +
        "4.0 m/s ≈ 4:10/km) only to override the synced value — a coach-entered number " +
        "or a hypothetical. An explicit value outranks the synced anchor; a manual " +
        "lower-boundary override is clamped and the clamp is disclosed. Returns zones " +
        "plus real source/confidence fields — surface the RPE-checked estimate framing " +
        "to the athlete; never present these as lab-measured thresholds. If no critical " +
        "speed is synced or supplied, the tool returns a no_cs_anchor error — ask the " +
        "athlete for a recent CS / threshold test rather than guessing.",
      inputSchema: zodSchema(
        z.object({
          criticalSpeedMps: z
            .number()
            .min(CS_SANITY_MPS.min)
            .max(CS_SANITY_MPS.max)
            .optional()
            .describe(
              "Override critical speed in m/s (intervals.icu threshold_pace is already m/s). " +
                "Omit to use the synced anchor when one exists. " +
                `Sane band [${CS_SANITY_MPS.min}, ${CS_SANITY_MPS.max}].`,
            ),
          paceUnits: z
            .enum(["MINS_KM", "MINS_MILE"])
            .nullish()
            .describe("Display unit; defaults to min/km when absent."),
          lowerFractionOverride: z
            .number()
            .positive()
            .optional()
            .describe(
              "Manual LT1 (easy↔moderate) boundary as a fraction of CS; outranks the " +
                `flat 0.823. Clamped to [${LOWER_FRACTION_CLAMP.min}, ${LOWER_FRACTION_CLAMP.max}].`,
            ),
          csSource: z
            .enum(["platform", "athlete_manual"])
            .default("platform")
            .describe(
              "Provenance of an EXPLICIT criticalSpeedMps; ignored when the synced " +
                "anchor is used (its provenance is reported instead). 'athlete_manual' = " +
                "coach/athlete-entered.",
            ),
        }),
      ),
      execute: async (input: {
        criticalSpeedMps?: number;
        paceUnits?: "MINS_KM" | "MINS_MILE" | null;
        lowerFractionOverride?: number;
        csSource?: "platform" | "athlete_manual";
      }) => {
        const resolved = resolvedCs?.() ?? null;
        // Explicit value (already band-checked by the input schema) outranks the
        // synced anchor (band-checked by resolveRunningCs); whichever we use is
        // therefore guaranteed in [CS_SANITY_MPS.min, max].
        const autoResolved = input.criticalSpeedMps === undefined && resolved !== null;
        const cs = input.criticalSpeedMps ?? resolved?.criticalSpeedMps;
        if (cs === undefined) {
          return {
            error: "no_cs_anchor",
            details:
              "No critical speed is synced from intervals.icu or supplied. Ask the athlete " +
              "for a recent critical-speed / threshold-pace test (or have them set threshold " +
              "pace in intervals.icu), then retry — do not invent a value.",
          };
        }

        let lowerFraction: number | undefined;
        let clampApplied: { requested: number; clamped: number } | undefined;
        if (input.lowerFractionOverride !== undefined) {
          const { value, clamped } = clampLowerFraction(input.lowerFractionOverride);
          lowerFraction = value;
          if (clamped) clampApplied = { requested: input.lowerFractionOverride, clamped: value };
        }

        const zones: RunningZoneDisplay[] = calculateRunningZones(
          cs,
          input.paceUnits ?? null,
          lowerFraction,
        );

        const csSource = autoResolved ? resolved.source : input.csSource ?? "platform";

        return {
          zones,
          criticalSpeedMps: cs,
          thresholdDefinition: THRESHOLD_DEFINITION,
          framing: RPE_FRAMING,
          csSource,
          anchorOrigin: autoResolved ? "auto-resolved" : "supplied",
          confidence: csSource === "athlete_manual" ? "coach-entered" : "platform-reported",
          ...(autoResolved && resolved.confidence ? { platformConfidence: resolved.confidence } : {}),
          ...(clampApplied ? { clampApplied } : {}),
        };
      },
    }),

    ...(intervals
      ? {
          intervals_create_workout: tool({
            description:
              "Create a structured running workout on the intervals.icu calendar (auto-syncs to " +
              "Garmin/Wahoo). Supply the workout as structured steps — the tool serializes them into " +
              "intervals.icu's native pace syntax so the pace chart renders and the server computes load " +
              "against the athlete's own threshold pace. Anchor pace targets on the critical-speed zones " +
              "(kind:'zone' 1-6, or kind:'cs_fraction') — these are RPE-checked estimates from a " +
              "population-mean model, not lab-measured thresholds. If the athlete's critical speed is a " +
              "manual/coach-entered override, prefer absolute kind:'pace' targets so the prescription " +
              "matches the zone table you showed them. Strides are a neuromuscular drill — prescribe them " +
              "as a duration-only step (or with a relaxed-fast kind:'pace'), never a CS zone. Do not invent " +
              "a pace the resolved CS doesn't support. Durations may be time (seconds/minutes) or distance " +
              "(meters/km/mi); a distance step needs a pace target so its planned time can be derived. For " +
              "every pushed workout, put the RPE-check + provenance framing, plus athlete-facing coaching " +
              "narrative (feel, RPE cues, target spm, hydration), in your chat reply — the calendar entry " +
              "cannot carry it.",
            inputSchema: zodSchema(
              z.object({
                date: z.string().describe("Workout date (YYYY-MM-DD)"),
                workout: runningWorkoutInputSchema.describe(
                  "Structured workout: name + ordered steps. Top-level steps can be simple " +
                    "(warmup/steady/tempo/threshold/interval/repetition/strides/ramp/recovery/rest/cooldown) " +
                    "or a set {type:'set', repeat, interval, recovery}. Durations use time (seconds/minutes) " +
                    "or distance (meters/distance_km/distance_mi); a distance step needs a pace target. Pace " +
                    "targets: {kind:'zone'|'cs_fraction'|'pace', value} or {kind, low, high} for ranges. " +
                    "cs_fraction is a fraction of critical speed (1.0 = threshold). Absolute 'pace' is M:SS " +
                    "strings, slower-first for ranges. Ramps require low+high.",
                ),
              }),
            ),
            execute: async (input: { date: string; workout: RunningWorkoutInput }) => {
              // The serializer stays pure: pass OUR resolved CS in so distance steps
              // with relative targets can derive their planned time.
              let serialized: ReturnType<typeof serializeRunningWorkout>;
              try {
                serialized = serializeRunningWorkout(input.workout, resolvedCs?.()?.criticalSpeedMps);
              } catch (err) {
                if (err instanceof InvalidWorkoutError) {
                  return { error: "invalid_workout", details: err.message };
                }
                throw err;
              }
              const result = await intervals.events.create({
                start_date_local: `${input.date}T00:00:00`,
                category: "WORKOUT",
                name: input.workout.name,
                type: "Run",
                moving_time: serialized.movingTime,
                // No icu_training_load — the server derives running Pace Load from the
                // parsed steps against the athlete's own threshold pace.
                description: serialized.description,
              });
              if (!result.ok) return { error: result.error.kind };
              return { created: true, event: result.value };
            },
          }),
        }
      : {}),
  };
}
