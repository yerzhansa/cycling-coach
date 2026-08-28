export interface CyclingSeasonWeekMetadata {
  readonly phase: string;
  readonly purpose: string;
}

export interface CyclingSeasonConstraintMetadata {
  readonly weekIndex: number;
  readonly title: string;
  readonly detail: string;
}

export interface CyclingSeasonMetadata {
  readonly weeks: readonly CyclingSeasonWeekMetadata[];
  readonly priority: "A" | "B" | "C" | null;
  readonly distanceKm: number | null;
  readonly constraint: CyclingSeasonConstraintMetadata | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && /\S/u.test(value) ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

const FOCUS_COPY: Readonly<Record<string, CyclingSeasonWeekMetadata>> = Object.freeze({
  base_building: { phase: "Base", purpose: "Build aerobic durability" },
  aerobic_development: { phase: "Base", purpose: "Develop aerobic capacity" },
  threshold: { phase: "Build", purpose: "Develop threshold" },
  vo2max: { phase: "Build", purpose: "Develop high-intensity capacity" },
  race_prep: { phase: "Build", purpose: "Practice race demands" },
  taper: { phase: "Taper", purpose: "Reduce volume; keep sharpness" },
  recovery: { phase: "Recovery", purpose: "Absorb the training block" },
  maintenance: { phase: "Base", purpose: "Maintain fitness" },
  general_fitness: { phase: "Base", purpose: "Build general fitness" },
});

function phaseCopy(value: UnknownRecord): CyclingSeasonWeekMetadata {
  const focus = text(value.focus);
  const accepted = focus === null ? undefined : FOCUS_COPY[focus];
  const phase = text(value.displayName) ?? text(value.name) ?? accepted?.phase ?? "Plan";
  const purpose = text(value.purpose) ?? accepted?.purpose ?? "Follow the approved week";
  return { phase, purpose };
}

function explicitWeeks(source: UnknownRecord): readonly CyclingSeasonWeekMetadata[] {
  if (!Array.isArray(source.seasonWeeks)) return [];
  return source.seasonWeeks.flatMap((value) => {
    const item = record(value);
    if (item === null) return [];
    const phase = text(item.phase);
    const purpose = text(item.purpose);
    return phase === null || purpose === null ? [] : [{ phase, purpose }];
  });
}

function phaseWeeks(source: UnknownRecord): readonly CyclingSeasonWeekMetadata[] {
  if (!Array.isArray(source.phases)) return [];
  return source.phases.flatMap((value) => {
    const phase = record(value);
    if (phase === null) return [];
    const durationWeeks = positiveInteger(phase.durationWeeks);
    if (durationWeeks === null) return [];
    return Array.from({ length: durationWeeks }, () => phaseCopy(phase));
  });
}

function constraint(
  source: UnknownRecord,
  totalWeeks: number,
): CyclingSeasonConstraintMetadata | null {
  const value = record(source.seasonConstraint);
  if (value === null) return null;
  const weekIndex = positiveInteger(value.weekIndex);
  const title = text(value.title);
  const detail = text(value.detail);
  return weekIndex === null || weekIndex > totalWeeks || title === null || detail === null
    ? null
    : { weekIndex, title, detail };
}

/**
 * Converts optional cycling Plan structure into stable athlete-facing week metadata.
 * Missing metadata degrades to honest generic labels; it never blocks the Plan read.
 */
export function projectCyclingSeasonMetadata(
  value: unknown,
  totalWeeks: number,
): CyclingSeasonMetadata {
  if (!Number.isSafeInteger(totalWeeks) || totalWeeks <= 0) {
    throw new TypeError("totalWeeks must be a positive integer");
  }
  const source = record(value) ?? {};
  const projected = explicitWeeks(source);
  const phases = projected.length > 0 ? projected : phaseWeeks(source);
  const fallback: CyclingSeasonWeekMetadata = {
    phase: "Plan",
    purpose: "Follow the approved week",
  };
  const weeks = Array.from({ length: totalWeeks }, (_, index) => phases[index] ?? fallback);
  const priorityValue = text(source.racePriority)?.toUpperCase();
  const priority =
    priorityValue === "A" || priorityValue === "B" || priorityValue === "C" ? priorityValue : null;
  return Object.freeze({
    weeks: Object.freeze(weeks),
    priority,
    distanceKm: positiveNumber(source.raceDistanceKm),
    constraint: constraint(source, totalWeeks),
  });
}
