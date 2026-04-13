import type { VolumeTier, DayOfWeek } from "./schemas.js";

// ============================================================================
// TYPES
// ============================================================================

export type WorkoutType = "endurance" | "sweet_spot" | "threshold" | "long" | "recovery";

export interface SampleWorkout {
  day?: string;
  name: string;
  duration: string;
  type: WorkoutType;
  spacing?: string;
}

interface TemplateSession {
  name: string;
  duration: string;
  type: WorkoutType;
  priority: number;
  isHard: boolean;
}

// ============================================================================
// DAY HELPERS
// ============================================================================

const DAY_LABELS: Record<DayOfWeek, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const DAY_ORDER: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function dayIndex(day: DayOfWeek): number {
  return DAY_ORDER.indexOf(day);
}

// ============================================================================
// CYCLING TEMPLATES (Base Phase)
// ============================================================================

const CYCLING_TEMPLATES: Record<VolumeTier, TemplateSession[]> = {
  low: [
    { name: "Endurance Ride Z2", duration: "45min", type: "endurance", priority: 2, isHard: false },
    { name: "Sweet Spot", duration: "60min", type: "sweet_spot", priority: 1, isHard: true },
    { name: "Long Ride", duration: "1.5h", type: "long", priority: 0, isHard: false },
  ],
  medium: [
    { name: "Endurance Ride Z2", duration: "60min", type: "endurance", priority: 2, isHard: false },
    { name: "Sweet Spot", duration: "75min", type: "sweet_spot", priority: 1, isHard: true },
    { name: "Long Ride", duration: "2.5h", type: "long", priority: 0, isHard: false },
    { name: "Recovery Spin", duration: "45min", type: "recovery", priority: 3, isHard: false },
  ],
  high: [
    { name: "Endurance Ride Z2", duration: "60min", type: "endurance", priority: 3, isHard: false },
    {
      name: "Threshold Intervals",
      duration: "75min",
      type: "threshold",
      priority: 1,
      isHard: true,
    },
    { name: "Endurance Ride Z2", duration: "50min", type: "endurance", priority: 4, isHard: false },
    { name: "Sweet Spot", duration: "75min", type: "sweet_spot", priority: 2, isHard: true },
    { name: "Long Ride", duration: "3h", type: "long", priority: 0, isHard: false },
    { name: "Recovery Spin", duration: "45min", type: "recovery", priority: 5, isHard: false },
  ],
};

// ============================================================================
// FIXED SCHEDULE PLACEMENT
// ============================================================================

function placeFixedSchedule(
  templates: TemplateSession[],
  availableDays: DayOfWeek[],
  keySessionDay?: DayOfWeek,
): SampleWorkout[] {
  const sortedDays = [...availableDays].sort((a, b) => dayIndex(a) - dayIndex(b));
  const toPlace = [...templates].slice(0, sortedDays.length);

  const longIdx = toPlace.findIndex((s) => s.type === "long");
  const longSession = longIdx >= 0 ? toPlace.splice(longIdx, 1)[0] : null;

  const hard = toPlace.filter((s) => s.isHard).sort((a, b) => a.priority - b.priority);
  const easy = toPlace.filter((s) => !s.isHard).sort((a, b) => a.priority - b.priority);

  const assignments = new Map<DayOfWeek, TemplateSession>();

  // Place long ride on key session day or last available day
  const longDay =
    keySessionDay && sortedDays.includes(keySessionDay)
      ? keySessionDay
      : sortedDays[sortedDays.length - 1];
  if (longSession) {
    assignments.set(longDay, longSession);
  }

  // Place hard sessions with maximum spacing
  const remainingDays = sortedDays.filter((d) => !assignments.has(d));
  for (const session of hard) {
    if (remainingDays.length === 0) break;
    const assignedHardDays = [...assignments.entries()]
      .filter(([, s]) => s.isHard || s.type === "long")
      .map(([d]) => dayIndex(d));

    let bestDay = remainingDays[0];
    let bestMinDist = -1;
    for (const day of remainingDays) {
      const di = dayIndex(day);
      const minDist =
        assignedHardDays.length > 0
          ? Math.min(
              ...assignedHardDays.map((hi) => Math.min(Math.abs(di - hi), 7 - Math.abs(di - hi))),
            )
          : 7;
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestDay = day;
      }
    }
    assignments.set(bestDay, session);
    remainingDays.splice(remainingDays.indexOf(bestDay), 1);
  }

  // Fill remaining days with easy sessions
  for (const session of easy) {
    if (remainingDays.length === 0) break;
    assignments.set(remainingDays.shift()!, session);
  }

  return sortedDays
    .filter((d) => assignments.has(d))
    .map((d) => {
      const s = assignments.get(d)!;
      return {
        day: DAY_LABELS[d],
        name: `${s.name} ${s.duration}`,
        duration: s.duration,
        type: s.type,
      };
    });
}

// ============================================================================
// FLEXIBLE SCHEDULE STACK
// ============================================================================

function buildFlexibleStack(
  templates: TemplateSession[],
  sessionsPerWeek?: number,
): SampleWorkout[] {
  const sorted = [...templates].sort((a, b) => {
    if (a.type === "long") return 1;
    if (b.type === "long") return -1;
    if (a.type === "recovery") return 1;
    if (b.type === "recovery") return -1;
    return a.priority - b.priority;
  });

  const hardSessions = sorted.filter((s) => s.isHard);
  const easySessions = sorted.filter(
    (s) => !s.isHard && s.type !== "long" && s.type !== "recovery",
  );
  const longSession = sorted.find((s) => s.type === "long");
  const recoverySessions = sorted.filter((s) => s.type === "recovery");

  const ordered: TemplateSession[] = [];
  let ei = 0;
  let hi = 0;
  while (ei < easySessions.length || hi < hardSessions.length) {
    if (ei < easySessions.length) ordered.push(easySessions[ei++]);
    if (hi < hardSessions.length) ordered.push(hardSessions[hi++]);
  }
  if (longSession) ordered.push(longSession);
  for (const r of recoverySessions) ordered.push(r);

  const limited = sessionsPerWeek ? ordered.slice(0, sessionsPerWeek) : ordered;

  return limited.map((s, i) => {
    const workout: SampleWorkout = {
      name: `${s.name} ${s.duration}`,
      duration: s.duration,
      type: s.type,
    };
    if (s.type === "long" && i > 0) {
      workout.spacing = "Rest day before this session";
    } else if (s.isHard && i > 0 && limited[i - 1]?.isHard) {
      workout.spacing = "Easy day or rest before this";
    }
    return workout;
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function getSampleWeek(
  volumeTier: VolumeTier,
  scheduleType: "fixed" | "flexible",
  availableDays?: DayOfWeek[],
  keySessionDay?: DayOfWeek,
  sessionsPerWeek?: number,
): SampleWorkout[] {
  const templates = CYCLING_TEMPLATES[volumeTier];

  if (scheduleType === "fixed" && availableDays && availableDays.length > 0) {
    return placeFixedSchedule(templates, availableDays, keySessionDay);
  }

  return buildFlexibleStack(templates, sessionsPerWeek);
}
