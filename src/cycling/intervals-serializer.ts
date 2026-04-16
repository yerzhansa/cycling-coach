import { z } from "zod";

export class InvalidWorkoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkoutError";
  }
}

// ============================================================================
// SCHEMA
// ============================================================================

const stepTypeSchema = z.enum([
  "warmup",
  "steady",
  "interval",
  "ramp",
  "recovery",
  "rest",
  "cooldown",
  "freeride",
]);

const powerKindSchema = z.enum(["watts", "percent_ftp", "zone"]);

const powerTargetSchema = z.object({
  kind: powerKindSchema,
  value: z.number().positive().optional(),
  low: z.number().positive().optional(),
  high: z.number().positive().optional(),
});

const durationSchema = z.object({
  value: z.number().positive(),
  unit: z.enum(["seconds", "minutes"]),
});

const cadenceSchema = z.object({
  target: z.number().int().positive().max(200).optional(),
  low: z.number().int().positive().max(200).optional(),
  high: z.number().int().positive().max(200).optional(),
});

const simpleStepSchema = z.object({
  type: stepTypeSchema,
  duration: durationSchema,
  power: powerTargetSchema.optional(),
  cadence: cadenceSchema.optional(),
  label: z.string().max(120).optional(),
});

const setStepSchema = z.object({
  type: z.literal("set"),
  repeat: z.number().int().min(1).max(20),
  interval: simpleStepSchema,
  recovery: simpleStepSchema,
});

export const intervalsWorkoutInputSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(z.union([simpleStepSchema, setStepSchema])).min(1).max(40),
});

export type IntervalsWorkoutInput = z.infer<typeof intervalsWorkoutInputSchema>;

type SimpleStep = z.infer<typeof simpleStepSchema>;
type SetStep = z.infer<typeof setStepSchema>;
type PowerTarget = z.infer<typeof powerTargetSchema>;
type CadenceTarget = z.infer<typeof cadenceSchema>;
type AnyStep = SimpleStep | SetStep;
type DurationInput = z.infer<typeof durationSchema>;

// ============================================================================
// CONSTANTS
// ============================================================================

// Intensity midpoints per zone (fraction of FTP). Used for load estimation.
const ZONE_INTENSITY: Record<number, number> = {
  1: 0.45,
  2: 0.65,
  3: 0.83,
  4: 0.91,
  5: 1.0,
  6: 1.13,
  7: 1.3,
};

const MAX_WATTS = 1500;
const MAX_PERCENT_FTP = 200;
const MAX_ZONE = 7;
const MIN_ZONE = 1;

// ============================================================================
// SERIALIZATION
// ============================================================================

function toSeconds(d: DurationInput): number {
  return d.unit === "seconds" ? d.value : d.value * 60;
}

function formatDuration(d: DurationInput): string {
  const total = Math.round(toSeconds(d));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}`;
}

function assertZone(n: number, path: string): void {
  if (!Number.isInteger(n) || n < MIN_ZONE || n > MAX_ZONE) {
    throw new InvalidWorkoutError(`${path}: zone must be an integer ${MIN_ZONE}-${MAX_ZONE}, got ${n}`);
  }
}

function formatPower(p: PowerTarget, isRamp: boolean, path: string): string {
  const hasRange = p.low !== undefined && p.high !== undefined;
  const hasValue = p.value !== undefined;

  if (isRamp) {
    if (!hasRange) {
      throw new InvalidWorkoutError(`${path}: ramp requires power.low and power.high`);
    }
    if (p.low! > p.high!) {
      throw new InvalidWorkoutError(`${path}: power.low (${p.low}) > power.high (${p.high})`);
    }
    if (p.kind === "zone") {
      assertZone(p.low!, `${path}.power.low`);
      assertZone(p.high!, `${path}.power.high`);
      return `ramp Z${p.low}-Z${p.high}`;
    }
    if (p.kind === "percent_ftp") return `ramp ${p.low}-${p.high}%`;
    return `ramp ${p.low}-${p.high}w`;
  }

  if (hasRange) {
    if (p.low! > p.high!) {
      throw new InvalidWorkoutError(`${path}: power.low (${p.low}) > power.high (${p.high})`);
    }
    if (p.kind === "zone") {
      assertZone(p.low!, `${path}.power.low`);
      assertZone(p.high!, `${path}.power.high`);
      return `Z${p.low}-Z${p.high}`;
    }
    if (p.kind === "percent_ftp") return `${p.low}-${p.high}%`;
    return `${p.low}-${p.high}w`;
  }

  if (hasValue) {
    if (p.kind === "zone") {
      assertZone(p.value!, `${path}.power.value`);
      return `Z${p.value}`;
    }
    if (p.kind === "percent_ftp") return `${p.value}%`;
    return `${p.value}w`;
  }

  throw new InvalidWorkoutError(`${path}: power requires 'value' or 'low'+'high'`);
}

function formatCadence(c: CadenceTarget, path: string): string {
  if (c.low !== undefined && c.high !== undefined) {
    if (c.low > c.high) {
      throw new InvalidWorkoutError(`${path}: cadence.low (${c.low}) > cadence.high (${c.high})`);
    }
    return `${c.low}-${c.high}rpm`;
  }
  if (c.target !== undefined) return `${c.target}rpm`;
  return "";
}

function formatStepLine(step: SimpleStep, path: string): string {
  const parts: string[] = [formatDuration(step.duration)];
  if (step.power) {
    parts.push(formatPower(step.power, step.type === "ramp", path));
  } else if (step.type === "ramp") {
    throw new InvalidWorkoutError(`${path}: ramp step requires a power target`);
  }
  if (step.cadence) {
    const cad = formatCadence(step.cadence, path);
    if (cad) parts.push(cad);
  }
  const body = parts.join(" ");
  return step.label ? `- ${body} ${step.label}` : `- ${body}`;
}

function sectionLabelFor(type: SimpleStep["type"] | "set"): string {
  if (type === "warmup") return "Warmup";
  if (type === "cooldown") return "Cooldown";
  return "Main set";
}

function validatePowerBounds(p: PowerTarget, path: string): void {
  const check = (v: number | undefined, name: string) => {
    if (v === undefined) return;
    if (p.kind === "watts" && v > MAX_WATTS) {
      throw new InvalidWorkoutError(`${path}.power.${name}: ${v}w exceeds sanity bound ${MAX_WATTS}w`);
    }
    if (p.kind === "percent_ftp" && v > MAX_PERCENT_FTP) {
      throw new InvalidWorkoutError(`${path}.power.${name}: ${v}% exceeds sanity bound ${MAX_PERCENT_FTP}%`);
    }
  };
  check(p.value, "value");
  check(p.low, "low");
  check(p.high, "high");
}

function validateSimpleStep(step: SimpleStep, path: string): void {
  if (step.duration.value <= 0) {
    throw new InvalidWorkoutError(`${path}: duration must be positive`);
  }
  if (step.type === "ramp" && !step.power) {
    throw new InvalidWorkoutError(`${path}: ramp step requires a power target`);
  }
  if (step.power) {
    const p = step.power;
    const hasValue = p.value !== undefined;
    const hasRange = p.low !== undefined && p.high !== undefined;
    if (!hasValue && !hasRange) {
      throw new InvalidWorkoutError(`${path}: power requires 'value' or 'low'+'high'`);
    }
    if (step.type === "ramp" && !hasRange) {
      throw new InvalidWorkoutError(`${path}: ramp requires power.low and power.high`);
    }
    validatePowerBounds(p, path);
  }
}

function validateStep(step: AnyStep, path: string): void {
  if (step.type === "set") {
    validateSimpleStep(step.interval, `${path}.interval`);
    validateSimpleStep(step.recovery, `${path}.recovery`);
    return;
  }
  validateSimpleStep(step, path);
}

// ============================================================================
// LOAD ESTIMATION
// ============================================================================

function intensityFor(step: SimpleStep, ftpWatts: number | undefined): number | undefined {
  if (!step.power) return 0; // freeride/rest: counts zero load
  const p = step.power;
  const mid = (a?: number, b?: number): number | undefined =>
    a !== undefined && b !== undefined ? (a + b) / 2 : undefined;

  if (p.kind === "zone") {
    const z = p.value ?? mid(p.low, p.high);
    if (z === undefined) return undefined;
    const lo = Math.floor(z);
    const hi = Math.ceil(z);
    const loI = ZONE_INTENSITY[lo];
    const hiI = ZONE_INTENSITY[hi];
    if (loI === undefined || hiI === undefined) return undefined;
    return (loI + hiI) / 2;
  }

  if (p.kind === "percent_ftp") {
    const pct = p.value ?? mid(p.low, p.high);
    return pct === undefined ? undefined : pct / 100;
  }

  // watts
  if (ftpWatts === undefined) return undefined;
  const w = p.value ?? mid(p.low, p.high);
  return w === undefined ? undefined : w / ftpWatts;
}

function computeLoad(steps: AnyStep[], ftpWatts: number | undefined): number | undefined {
  let sum = 0;
  let anyPower = false;
  let wattsNoFtp = false;

  const visit = (step: AnyStep, multiplier: number): void => {
    if (step.type === "set") {
      visit(step.interval, multiplier * step.repeat);
      visit(step.recovery, multiplier * step.repeat);
      return;
    }
    const secs = toSeconds(step.duration) * multiplier;
    const intensity = intensityFor(step, ftpWatts);
    if (intensity === undefined) {
      if (step.power?.kind === "watts") wattsNoFtp = true;
      return;
    }
    if (intensity > 0) anyPower = true;
    sum += secs * intensity * intensity;
  };

  for (const s of steps) visit(s, 1);

  if (wattsNoFtp) return undefined;
  if (!anyPower) return undefined;
  return Math.round((sum / 3600) * 100);
}

function totalSeconds(steps: AnyStep[]): number {
  let total = 0;
  const visit = (step: AnyStep, multiplier: number): void => {
    if (step.type === "set") {
      visit(step.interval, multiplier * step.repeat);
      visit(step.recovery, multiplier * step.repeat);
      return;
    }
    total += toSeconds(step.duration) * multiplier;
  };
  for (const s of steps) visit(s, 1);
  return Math.round(total);
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function serializeIntervalsWorkout(
  input: IntervalsWorkoutInput,
  opts?: { ftpWatts?: number },
): { description: string; movingTime: number; trainingLoad: number | undefined } {
  const parsed = intervalsWorkoutInputSchema.parse(input);
  parsed.steps.forEach((s, i) => validateStep(s, `steps[${i}]`));

  const lines: string[] = [];
  let currentLabel: string | null = null;

  parsed.steps.forEach((step, i) => {
    const label = sectionLabelFor(step.type);
    if (label !== currentLabel) {
      if (lines.length > 0) lines.push("");
      lines.push(label);
      currentLabel = label;
    }
    const path = `steps[${i}]`;
    if (step.type === "set") {
      lines.push(`${step.repeat}x`);
      lines.push(formatStepLine(step.interval, `${path}.interval`));
      lines.push(formatStepLine(step.recovery, `${path}.recovery`));
    } else {
      lines.push(formatStepLine(step, path));
    }
  });

  return {
    description: lines.join("\n"),
    movingTime: totalSeconds(parsed.steps),
    trainingLoad: computeLoad(parsed.steps, opts?.ftpWatts),
  };
}
