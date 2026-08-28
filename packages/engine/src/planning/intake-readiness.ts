import type { PlanFtpSnapshot } from "./ftp.js";

export type PlanIntakeRequirement =
  | "event"
  | "priority"
  | "date"
  | "goal"
  | "availability"
  | "experience"
  | "ftp"
  | "course-choice";

export interface PlanIntakeReadinessInput {
  readonly intake:
    | {
        readonly eventName: string | null;
        readonly eventPriority: "A" | "B" | "C" | null;
        readonly eventDateKey: number | null;
        readonly athleteGoal: string | null;
        readonly availabilitySessionsPerWeek: number | null;
        readonly availabilityWeekdays: readonly string[];
        readonly experience: string | null;
      }
    | undefined;
  readonly ftp: PlanFtpSnapshot | undefined;
  readonly courseChoice: "undecided" | "omitted" | "attached";
  readonly minimumEventDateKey?: number;
  readonly maximumEventDateKey?: number;
}

export interface PlanIntakeReadiness {
  readonly ready: boolean;
  readonly missing: readonly PlanIntakeRequirement[];
}

export function evaluatePlanIntakeReadiness(input: PlanIntakeReadinessInput): PlanIntakeReadiness {
  const missing: PlanIntakeRequirement[] = [];
  if (input.intake?.eventName === null || input.intake?.eventName === undefined) {
    missing.push("event");
  }
  if (input.intake?.eventPriority === null || input.intake?.eventPriority === undefined) {
    missing.push("priority");
  }
  if (
    input.intake?.eventDateKey === null ||
    input.intake?.eventDateKey === undefined ||
    (input.minimumEventDateKey !== undefined &&
      input.intake.eventDateKey < input.minimumEventDateKey) ||
    (input.maximumEventDateKey !== undefined &&
      input.intake.eventDateKey > input.maximumEventDateKey)
  ) {
    missing.push("date");
  }
  if (input.intake?.athleteGoal === null || input.intake?.athleteGoal === undefined) {
    missing.push("goal");
  }
  if (
    input.intake?.availabilitySessionsPerWeek === null ||
    input.intake?.availabilitySessionsPerWeek === undefined ||
    input.intake.availabilitySessionsPerWeek > 6 ||
    input.intake.availabilityWeekdays.length < input.intake.availabilitySessionsPerWeek
  ) {
    missing.push("availability");
  }
  if (input.intake?.experience === null || input.intake?.experience === undefined) {
    missing.push("experience");
  }
  if (input.ftp?.usedSource === null || input.ftp?.usedWatts === null || input.ftp === undefined) {
    missing.push("ftp");
  }
  if (input.courseChoice === "undecided") missing.push("course-choice");
  return Object.freeze({ ready: missing.length === 0, missing: Object.freeze(missing) });
}
