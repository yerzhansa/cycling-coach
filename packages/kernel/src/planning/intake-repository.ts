import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { addCivilDays } from "./date-keys.js";
import {
  PlanConversationValidationError,
  type PlanConversationTurnRecord,
  validatePlanConversationTurnRecord,
} from "./conversation-repository.js";

export type PlanIntakeExperience = "beginner" | "intermediate" | "advanced" | "elite";
export type PlanIntakeWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface PlanIntakeRecord {
  readonly conversationId: string;
  readonly eventName: string | null;
  readonly eventPriority: "A" | "B" | "C" | null;
  readonly eventDateKey: number | null;
  readonly athleteGoal: string | null;
  readonly availabilitySessionsPerWeek: number | null;
  readonly availabilityWeekdays: readonly PlanIntakeWeekday[];
  readonly experience: PlanIntakeExperience | null;
  readonly currentTrainingSummary: string | null;
  readonly sourceTurnSequence: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanIntakeExpectedVersion {
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanIntakeRepository {
  read(conversationId: string): Promise<PlanIntakeRecord | undefined>;
  save(
    record: PlanIntakeRecord,
    expectedVersion: PlanIntakeExpectedVersion | null,
  ): Promise<PlanIntakeRecord>;
  appendTurnWithIntake?(
    turn: PlanConversationTurnRecord,
    intake: PlanIntakeRecord,
    expectedVersion: PlanIntakeExpectedVersion,
  ): Promise<{ readonly turn: PlanConversationTurnRecord; readonly intake: PlanIntakeRecord }>;
}

export type PlanIntakeValidationErrorCode =
  | "invalid-intake"
  | "missing-conversation"
  | "missing-intake"
  | "stale-intake";

export class PlanIntakeValidationError extends Error {
  readonly code: PlanIntakeValidationErrorCode;

  constructor(code: PlanIntakeValidationErrorCode) {
    super(`plan intake rejected: ${code}`);
    this.name = "PlanIntakeValidationError";
    this.code = code;
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXPERIENCE = new Set<unknown>(["beginner", "intermediate", "advanced", "elite"]);
const EVENT_PRIORITY = new Set<unknown>(["A", "B", "C"]);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const WEEKDAY_INDEX = new Map<PlanIntakeWeekday, number>(
  WEEKDAYS.map((weekday, index) => [weekday, index]),
);

function validNullableText(value: unknown, maxLength: number): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      value.trim() === value)
  );
}

function validDateKey(value: number | null): boolean {
  if (value === null) return true;
  try {
    return addCivilDays(value, 0) === value;
  } catch {
    return false;
  }
}

function weekdaysToMask(value: readonly PlanIntakeWeekday[]): number {
  let mask = 0;
  let previous = -1;
  for (const weekday of value) {
    const index = WEEKDAY_INDEX.get(weekday);
    if (index === undefined || index <= previous) {
      throw new PlanIntakeValidationError("invalid-intake");
    }
    mask |= 1 << index;
    previous = index;
  }
  return mask;
}

function maskToWeekdays(value: number): readonly PlanIntakeWeekday[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 127) {
    throw new PlanIntakeValidationError("invalid-intake");
  }
  return Object.freeze(WEEKDAYS.filter((_, index) => (value & (1 << index)) !== 0));
}

function validVersion(value: PlanIntakeExpectedVersion): boolean {
  return (
    Number.isSafeInteger(value.updatedAtMs) &&
    value.updatedAtMs >= 0 &&
    DEVICE_ID.test(value.deviceId) &&
    Number.isSafeInteger(value.hlcPhysicalMs) &&
    value.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(value.hlcCounter) &&
    value.hlcCounter >= 0
  );
}

function validate(record: PlanIntakeRecord): void {
  if (
    !ULID.test(record.conversationId) ||
    !validNullableText(record.eventName, 200) ||
    (record.eventPriority !== null && !EVENT_PRIORITY.has(record.eventPriority)) ||
    !validDateKey(record.eventDateKey) ||
    !validNullableText(record.athleteGoal, 1_000) ||
    (record.availabilitySessionsPerWeek !== null &&
      (!Number.isSafeInteger(record.availabilitySessionsPerWeek) ||
        record.availabilitySessionsPerWeek < 1 ||
        record.availabilitySessionsPerWeek > 6)) ||
    !Array.isArray(record.availabilityWeekdays) ||
    (record.experience !== null && !EXPERIENCE.has(record.experience)) ||
    !validNullableText(record.currentTrainingSummary, 2_000) ||
    !Number.isSafeInteger(record.sourceTurnSequence) ||
    record.sourceTurnSequence < 0 ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0
  ) {
    throw new PlanIntakeValidationError("invalid-intake");
  }
  weekdaysToMask(record.availabilityWeekdays);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanIntakeValidationError("invalid-intake");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanIntakeValidationError("invalid-intake");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanIntakeValidationError("invalid-intake");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanIntakeValidationError("invalid-intake");
  }
  return value;
}

function fromRow(row: Row): PlanIntakeRecord {
  const record: PlanIntakeRecord = {
    conversationId: text(row, "conversation_id"),
    eventName: nullableText(row, "event_name"),
    eventPriority: nullableText(row, "event_priority") as "A" | "B" | "C" | null,
    eventDateKey: nullableInteger(row, "event_date_key"),
    athleteGoal: nullableText(row, "athlete_goal"),
    availabilitySessionsPerWeek: nullableInteger(row, "availability_sessions_per_week"),
    availabilityWeekdays: maskToWeekdays(integer(row, "availability_weekdays_mask")),
    experience: nullableText(row, "experience") as PlanIntakeExperience | null,
    currentTrainingSummary: nullableText(row, "current_training_summary"),
    sourceTurnSequence: integer(row, "source_turn_sequence"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validate(record);
  return Object.freeze(record);
}

function matchesVersion(record: PlanIntakeRecord, expected: PlanIntakeExpectedVersion): boolean {
  return (
    record.updatedAtMs === expected.updatedAtMs &&
    record.deviceId === expected.deviceId &&
    record.hlcPhysicalMs === expected.hlcPhysicalMs &&
    record.hlcCounter === expected.hlcCounter
  );
}

function equalRecord(left: PlanIntakeRecord, right: PlanIntakeRecord): boolean {
  return (
    left.conversationId === right.conversationId &&
    left.eventName === right.eventName &&
    left.eventPriority === right.eventPriority &&
    left.eventDateKey === right.eventDateKey &&
    left.athleteGoal === right.athleteGoal &&
    left.availabilitySessionsPerWeek === right.availabilitySessionsPerWeek &&
    left.availabilityWeekdays.join(",") === right.availabilityWeekdays.join(",") &&
    left.experience === right.experience &&
    left.currentTrainingSummary === right.currentTrainingSummary &&
    left.sourceTurnSequence === right.sourceTurnSequence &&
    left.createdAtMs === right.createdAtMs &&
    matchesVersion(left, right)
  );
}

function sameTurnRow(row: Row, record: PlanConversationTurnRecord): boolean {
  return (
    row.id === record.id &&
    row.conversation_id === record.conversationId &&
    row.sequence === record.sequence &&
    row.athlete_text === record.athleteText &&
    row.coach_text === record.coachText &&
    row.lineage_json === record.lineageJson &&
    row.completed_at_ms === record.completedAtMs &&
    row.device_id === record.deviceId &&
    row.hlc_physical_ms === record.hlcPhysicalMs &&
    row.hlc_counter === record.hlcCounter
  );
}

const COLUMNS = `conversation_id,event_name,event_priority,event_date_key,athlete_goal,
availability_sessions_per_week,availability_weekdays_mask,experience,current_training_summary,
source_turn_sequence,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter`;

export function createPlanIntakeRepository(store: PlanningStore): PlanIntakeRepository {
  const read = async (conversationId: string): Promise<PlanIntakeRecord | undefined> => {
    if (!ULID.test(conversationId)) throw new PlanIntakeValidationError("invalid-intake");
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_intake WHERE conversation_id=?`, [
      conversationId,
    ]);
    return row === undefined ? undefined : fromRow(row);
  };

  return Object.freeze({
    read,
    async save(record: PlanIntakeRecord, expectedVersion: PlanIntakeExpectedVersion | null) {
      validate(record);
      if (expectedVersion !== null && !validVersion(expectedVersion)) {
        throw new PlanIntakeValidationError("invalid-intake");
      }
      return store.transaction(async () => {
        const conversation = await store.get(`SELECT id FROM plan_conversation WHERE id=?`, [
          record.conversationId,
        ]);
        if (conversation === undefined) {
          throw new PlanIntakeValidationError("missing-conversation");
        }
        const current = await read(record.conversationId);
        if (expectedVersion === null) {
          if (current !== undefined) throw new PlanIntakeValidationError("stale-intake");
          await store.run(
            `INSERT INTO plan_intake (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              record.conversationId,
              record.eventName,
              record.eventPriority,
              record.eventDateKey,
              record.athleteGoal,
              record.availabilitySessionsPerWeek,
              weekdaysToMask(record.availabilityWeekdays),
              record.experience,
              record.currentTrainingSummary,
              record.sourceTurnSequence,
              record.createdAtMs,
              record.updatedAtMs,
              record.deviceId,
              record.hlcPhysicalMs,
              record.hlcCounter,
            ],
          );
        } else {
          if (current === undefined) throw new PlanIntakeValidationError("missing-intake");
          if (!matchesVersion(current, expectedVersion)) {
            throw new PlanIntakeValidationError("stale-intake");
          }
          if (
            record.createdAtMs !== current.createdAtMs ||
            record.sourceTurnSequence < current.sourceTurnSequence ||
            record.updatedAtMs < expectedVersion.updatedAtMs ||
            record.hlcPhysicalMs < expectedVersion.hlcPhysicalMs ||
            (record.hlcPhysicalMs === expectedVersion.hlcPhysicalMs &&
              record.hlcCounter <= expectedVersion.hlcCounter)
          ) {
            throw new PlanIntakeValidationError("invalid-intake");
          }
          await store.run(
            `UPDATE plan_intake SET event_name=?,event_priority=?,event_date_key=?,athlete_goal=?,
availability_sessions_per_week=?,availability_weekdays_mask=?,experience=?,current_training_summary=?,
source_turn_sequence=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE conversation_id=?
AND updated_at_ms=? AND device_id=? AND hlc_physical_ms=? AND hlc_counter=?`,
            [
              record.eventName,
              record.eventPriority,
              record.eventDateKey,
              record.athleteGoal,
              record.availabilitySessionsPerWeek,
              weekdaysToMask(record.availabilityWeekdays),
              record.experience,
              record.currentTrainingSummary,
              record.sourceTurnSequence,
              record.updatedAtMs,
              record.deviceId,
              record.hlcPhysicalMs,
              record.hlcCounter,
              record.conversationId,
              expectedVersion.updatedAtMs,
              expectedVersion.deviceId,
              expectedVersion.hlcPhysicalMs,
              expectedVersion.hlcCounter,
            ],
          );
        }
        const stored = await read(record.conversationId);
        if (stored === undefined || !equalRecord(stored, record)) {
          throw new PlanIntakeValidationError("stale-intake");
        }
        return stored;
      });
    },
    async appendTurnWithIntake(
      turn: PlanConversationTurnRecord,
      record: PlanIntakeRecord,
      expectedVersion: PlanIntakeExpectedVersion,
    ) {
      validatePlanConversationTurnRecord(turn);
      validate(record);
      if (
        !validVersion(expectedVersion) ||
        turn.conversationId !== record.conversationId ||
        turn.sequence !== record.sourceTurnSequence
      ) {
        throw new PlanIntakeValidationError("invalid-intake");
      }
      return store.transaction(async () => {
        const conversation = await store.get("SELECT status FROM plan_conversation WHERE id=?", [
          turn.conversationId,
        ]);
        if (conversation === undefined) {
          throw new PlanIntakeValidationError("missing-conversation");
        }
        if (conversation.status !== "open") {
          throw new PlanConversationValidationError("conversation-ended");
        }
        const current = await read(record.conversationId);
        if (current === undefined) throw new PlanIntakeValidationError("missing-intake");
        if (!matchesVersion(current, expectedVersion)) {
          throw new PlanIntakeValidationError("stale-intake");
        }
        if (
          record.createdAtMs !== current.createdAtMs ||
          record.sourceTurnSequence <= current.sourceTurnSequence ||
          record.updatedAtMs < expectedVersion.updatedAtMs ||
          record.hlcPhysicalMs < expectedVersion.hlcPhysicalMs ||
          (record.hlcPhysicalMs === expectedVersion.hlcPhysicalMs &&
            record.hlcCounter <= expectedVersion.hlcCounter)
        ) {
          throw new PlanIntakeValidationError("invalid-intake");
        }
        const existingTurn = await store.get("SELECT * FROM plan_conversation_turn WHERE id=?", [
          turn.id,
        ]);
        if (existingTurn !== undefined) {
          if (!sameTurnRow(existingTurn, turn) || !equalRecord(current, record)) {
            throw new PlanConversationValidationError("turn-conflict");
          }
          return Object.freeze({ turn, intake: current });
        }
        const last = await store.get(
          "SELECT sequence FROM plan_conversation_turn WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1",
          [turn.conversationId],
        );
        const expectedSequence = last === undefined ? 1 : integer(last, "sequence") + 1;
        if (turn.sequence !== expectedSequence) {
          throw new PlanConversationValidationError("turn-conflict");
        }
        await store.run(
          `INSERT INTO plan_conversation_turn (
id,conversation_id,sequence,athlete_text,coach_text,lineage_json,
completed_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            turn.id,
            turn.conversationId,
            turn.sequence,
            turn.athleteText,
            turn.coachText,
            turn.lineageJson,
            turn.completedAtMs,
            turn.deviceId,
            turn.hlcPhysicalMs,
            turn.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE plan_intake SET event_name=?,event_priority=?,event_date_key=?,athlete_goal=?,
availability_sessions_per_week=?,availability_weekdays_mask=?,experience=?,current_training_summary=?,
source_turn_sequence=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=? WHERE conversation_id=?
AND updated_at_ms=? AND device_id=? AND hlc_physical_ms=? AND hlc_counter=?`,
          [
            record.eventName,
            record.eventPriority,
            record.eventDateKey,
            record.athleteGoal,
            record.availabilitySessionsPerWeek,
            weekdaysToMask(record.availabilityWeekdays),
            record.experience,
            record.currentTrainingSummary,
            record.sourceTurnSequence,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
            record.conversationId,
            expectedVersion.updatedAtMs,
            expectedVersion.deviceId,
            expectedVersion.hlcPhysicalMs,
            expectedVersion.hlcCounter,
          ],
        );
        const stored = await read(record.conversationId);
        if (stored === undefined || !equalRecord(stored, record)) {
          throw new PlanIntakeValidationError("stale-intake");
        }
        return Object.freeze({ turn, intake: stored });
      });
    },
  });
}
