export { calculateCyclingZones, ZONE_DESCRIPTIONS } from "./zones.js";
export type { CyclingZoneDisplay } from "./zones.js";

export {
  selectPeriodizationModel,
  computeTotalWeeks,
  BUILD_RECOVERY_RATIOS,
  TAPER_WEEKS,
  PHASE_TEMPLATES,
  VOLUME_PROGRESSION,
  INTENSITY_DISTRIBUTIONS,
  VOLUME_TIERS,
  VOLUME_TIER_MAPPING,
} from "./periodization.js";
export type { PeriodizationModel } from "./periodization.js";

export { assessGoalFeasibility } from "./feasibility.js";
export type { FeasibilityInput, FeasibilityResult } from "./feasibility.js";

export { getSampleWeek } from "./templates.js";
export type { SampleWorkout, WorkoutType } from "./templates.js";

export { buildPlanSkeleton } from "./plan-builder.js";

export * from "./schemas.js";
