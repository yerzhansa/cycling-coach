import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { inclusiveCivilDays } from "./date-keys.js";

export type AthletePreferenceStatus = "active" | "removed";
export type TrainingRestrictionKind = "no-training" | "no-hard-training" | "maximum-duration";
export type TrainingRestrictionStatus = "active" | "ended";

export interface AthletePreferenceRecord {
  readonly id: string;
  readonly preferenceKey: string;
  readonly valueJson: string;
  readonly status: AthletePreferenceStatus;
  readonly version: number;
  readonly sourceAnswerId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly removedAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CreateAthletePreferenceInput {
  readonly id: string;
  readonly preferenceKey: string;
  readonly valueJson: string;
  readonly sourceAnswerId: string | null;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface RemoveAthletePreferenceInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly removedAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface TrainingRestrictionRecord {
  readonly id: string;
  readonly kind: TrainingRestrictionKind;
  readonly status: TrainingRestrictionStatus;
  readonly version: number;
  readonly startDateKey: number;
  readonly endDateKey: number | null;
  readonly maximumDurationMinutes: number | null;
  readonly confirmedAtMs: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly endedAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CreateTrainingRestrictionInput {
  readonly id: string;
  readonly kind: TrainingRestrictionKind;
  readonly startDateKey: number;
  readonly endDateKey: number | null;
  readonly maximumDurationMinutes: number | null;
  readonly confirmedAtMs: number;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface EndTrainingRestrictionInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly endDateKey: number;
  readonly endedAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface AthletePlanningContextRepository {
  createPreference(input: CreateAthletePreferenceInput): Promise<AthletePreferenceRecord>;
  readPreference(id: string): Promise<AthletePreferenceRecord | undefined>;
  readActivePreferences(): Promise<readonly AthletePreferenceRecord[]>;
  removePreference(input: RemoveAthletePreferenceInput): Promise<AthletePreferenceRecord>;
  createRestriction(input: CreateTrainingRestrictionInput): Promise<TrainingRestrictionRecord>;
  readRestriction(id: string): Promise<TrainingRestrictionRecord | undefined>;
  readActiveRestrictions(): Promise<readonly TrainingRestrictionRecord[]>;
  endRestriction(input: EndTrainingRestrictionInput): Promise<TrainingRestrictionRecord>;
}

export type AthletePlanningContextStoreErrorCode =
  | "invalid-preference"
  | "invalid-restriction"
  | "preference-conflict"
  | "restriction-conflict"
  | "missing-preference"
  | "missing-restriction"
  | "stale-preference"
  | "stale-restriction"
  | "corrupt-record";

export class AthletePlanningContextStoreError extends Error {
  readonly code: AthletePlanningContextStoreErrorCode;

  constructor(code: AthletePlanningContextStoreErrorCode) {
    super(`Athlete Planning context rejected: ${code}`);
    this.name = "AthletePlanningContextStoreError";
    this.code = code;
  }
}

export type AthletePlanningContextStore = SqlStore & Pick<MigratorStore, "transaction">;
type TransactionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESTRICTION_KINDS = new Set<unknown>(["no-training", "no-hard-training", "maximum-duration"]);
const PREFERENCE_COLUMNS = `id,preference_key,value_json,status,version,source_answer_id,
created_at_ms,updated_at_ms,removed_at_ms,device_id,hlc_physical_ms,hlc_counter`;
const RESTRICTION_COLUMNS = `id,kind,status,version,start_date_key,end_date_key,
maximum_duration_minutes,confirmed_at_ms,created_at_ms,updated_at_ms,ended_at_ms,
device_id,hlc_physical_ms,hlc_counter`;

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validClock(value: {
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}): boolean {
  return (
    DEVICE_ID.test(value.deviceId) &&
    Number.isSafeInteger(value.hlcPhysicalMs) &&
    value.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(value.hlcCounter) &&
    value.hlcCounter >= 0
  );
}

function clockNotBefore(
  next: { readonly hlcPhysicalMs: number; readonly hlcCounter: number },
  current: { readonly hlcPhysicalMs: number; readonly hlcCounter: number },
): boolean {
  return (
    next.hlcPhysicalMs > current.hlcPhysicalMs ||
    (next.hlcPhysicalMs === current.hlcPhysicalMs && next.hlcCounter >= current.hlcCounter)
  );
}

function validDateRange(startDateKey: number, endDateKey: number | null): boolean {
  try {
    if (endDateKey === null) {
      inclusiveCivilDays(startDateKey, startDateKey);
      return true;
    }
    return inclusiveCivilDays(startDateKey, endDateKey) > 0;
  } catch {
    return false;
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AthletePlanningContextStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AthletePlanningContextStoreError("corrupt-record");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new AthletePlanningContextStoreError("corrupt-record");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new AthletePlanningContextStoreError("corrupt-record");
  }
  return value;
}

function validatePreference(record: AthletePreferenceRecord): void {
  if (
    !ULID.test(record.id) ||
    record.preferenceKey.length < 1 ||
    record.preferenceKey.length > 128 ||
    !validJson(record.valueJson) ||
    !["active", "removed"].includes(record.status) ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0 ||
    (record.sourceAnswerId !== null && !ULID.test(record.sourceAnswerId)) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !validClock(record) ||
    (record.status === "active") !== (record.removedAtMs === null) ||
    (record.removedAtMs !== null &&
      (!Number.isSafeInteger(record.removedAtMs) ||
        record.removedAtMs < record.createdAtMs ||
        record.removedAtMs > record.updatedAtMs))
  ) {
    throw new AthletePlanningContextStoreError("invalid-preference");
  }
}

function validateRestriction(record: TrainingRestrictionRecord): void {
  const maximumDuration = record.kind === "maximum-duration";
  if (
    !ULID.test(record.id) ||
    !RESTRICTION_KINDS.has(record.kind) ||
    !["active", "ended"].includes(record.status) ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0 ||
    !validDateRange(record.startDateKey, record.endDateKey) ||
    maximumDuration !== (record.maximumDurationMinutes !== null) ||
    (record.maximumDurationMinutes !== null &&
      (!Number.isSafeInteger(record.maximumDurationMinutes) ||
        record.maximumDurationMinutes <= 0)) ||
    !Number.isSafeInteger(record.confirmedAtMs) ||
    record.confirmedAtMs < 0 ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < record.confirmedAtMs ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !validClock(record) ||
    (record.status === "active") !== (record.endedAtMs === null) ||
    (record.endedAtMs !== null &&
      (!Number.isSafeInteger(record.endedAtMs) ||
        record.endedAtMs < record.createdAtMs ||
        record.endedAtMs > record.updatedAtMs))
  ) {
    throw new AthletePlanningContextStoreError("invalid-restriction");
  }
}

function preferenceFromRow(row: Row): AthletePreferenceRecord {
  const record: AthletePreferenceRecord = Object.freeze({
    id: text(row, "id"),
    preferenceKey: text(row, "preference_key"),
    valueJson: text(row, "value_json"),
    status: text(row, "status") as AthletePreferenceStatus,
    version: integer(row, "version"),
    sourceAnswerId: nullableText(row, "source_answer_id"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    removedAtMs: nullableInteger(row, "removed_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validatePreference(record);
  } catch {
    throw new AthletePlanningContextStoreError("corrupt-record");
  }
  return record;
}

function restrictionFromRow(row: Row): TrainingRestrictionRecord {
  const record: TrainingRestrictionRecord = Object.freeze({
    id: text(row, "id"),
    kind: text(row, "kind") as TrainingRestrictionKind,
    status: text(row, "status") as TrainingRestrictionStatus,
    version: integer(row, "version"),
    startDateKey: integer(row, "start_date_key"),
    endDateKey: nullableInteger(row, "end_date_key"),
    maximumDurationMinutes: nullableInteger(row, "maximum_duration_minutes"),
    confirmedAtMs: integer(row, "confirmed_at_ms"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    endedAtMs: nullableInteger(row, "ended_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validateRestriction(record);
  } catch {
    throw new AthletePlanningContextStoreError("corrupt-record");
  }
  return record;
}

export async function setAthletePreferenceInTransaction(
  store: SqlStore,
  input: CreateAthletePreferenceInput,
): Promise<void> {
  const record: AthletePreferenceRecord = {
    ...input,
    status: "active",
    version: 1,
    updatedAtMs: input.createdAtMs,
    removedAtMs: null,
  };
  validatePreference(record);
  const existing = await store.get(
    `SELECT ${PREFERENCE_COLUMNS} FROM athlete_preference WHERE id=?`,
    [record.id],
  );
  if (existing !== undefined) {
    throw new AthletePlanningContextStoreError("preference-conflict");
  }
  if (record.sourceAnswerId !== null) {
    const answer = await store.get(
      "SELECT scope,preference_id FROM plan_creation_answer WHERE id=?",
      [record.sourceAnswerId],
    );
    if (
      answer === undefined ||
      text(answer, "scope") !== "athlete-preference" ||
      nullableText(answer, "preference_id") !== record.id
    ) {
      throw new AthletePlanningContextStoreError("invalid-preference");
    }
  }
  const activeRow = await store.get(
    `SELECT ${PREFERENCE_COLUMNS} FROM athlete_preference
WHERE preference_key=? AND status='active'`,
    [record.preferenceKey],
  );
  if (activeRow !== undefined) {
    const active = preferenceFromRow(activeRow);
    if (
      record.createdAtMs < active.updatedAtMs ||
      record.hlcPhysicalMs < active.hlcPhysicalMs ||
      (record.hlcPhysicalMs === active.hlcPhysicalMs && record.hlcCounter < active.hlcCounter)
    ) {
      throw new AthletePlanningContextStoreError("stale-preference");
    }
    await store.run(
      `UPDATE athlete_preference SET status='removed',version=version+1,removed_at_ms=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status='active' AND version=?`,
      [
        record.createdAtMs,
        record.createdAtMs,
        record.deviceId,
        record.hlcPhysicalMs,
        record.hlcCounter,
        active.id,
        active.version,
      ],
    );
    const removed = await store.get("SELECT status,version FROM athlete_preference WHERE id=?", [
      active.id,
    ]);
    if (
      removed === undefined ||
      text(removed, "status") !== "removed" ||
      integer(removed, "version") !== active.version + 1
    ) {
      throw new AthletePlanningContextStoreError("stale-preference");
    }
  }
  await store.run(
    `INSERT INTO athlete_preference (${PREFERENCE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      record.id,
      record.preferenceKey,
      record.valueJson,
      record.status,
      record.version,
      record.sourceAnswerId,
      record.createdAtMs,
      record.updatedAtMs,
      record.removedAtMs,
      record.deviceId,
      record.hlcPhysicalMs,
      record.hlcCounter,
    ],
  );
}

function buildAthletePlanningContextRepository(
  store: SqlStore,
  runTransaction: TransactionRunner,
): AthletePlanningContextRepository {
  const readPreference = async (id: string): Promise<AthletePreferenceRecord | undefined> => {
    if (!ULID.test(id)) throw new AthletePlanningContextStoreError("invalid-preference");
    const row = await store.get(`SELECT ${PREFERENCE_COLUMNS} FROM athlete_preference WHERE id=?`, [
      id,
    ]);
    return row === undefined ? undefined : preferenceFromRow(row);
  };

  const readRestriction = async (id: string): Promise<TrainingRestrictionRecord | undefined> => {
    if (!ULID.test(id)) throw new AthletePlanningContextStoreError("invalid-restriction");
    const row = await store.get(
      `SELECT ${RESTRICTION_COLUMNS} FROM training_restriction WHERE id=?`,
      [id],
    );
    return row === undefined ? undefined : restrictionFromRow(row);
  };

  const repository: AthletePlanningContextRepository = {
    readPreference,
    readRestriction,
    async readActivePreferences() {
      const rows = await store.all(
        `SELECT ${PREFERENCE_COLUMNS} FROM athlete_preference WHERE status='active'
ORDER BY preference_key ASC,created_at_ms ASC,id ASC`,
      );
      return Object.freeze(rows.map(preferenceFromRow));
    },
    async readActiveRestrictions() {
      const rows = await store.all(
        `SELECT ${RESTRICTION_COLUMNS} FROM training_restriction WHERE status='active'
ORDER BY start_date_key ASC,created_at_ms ASC,id ASC`,
      );
      return Object.freeze(rows.map(restrictionFromRow));
    },
    async createPreference(input) {
      return runTransaction(async () => {
        const existing = await readPreference(input.id);
        if (existing !== undefined) {
          if (
            existing.status === "active" &&
            existing.preferenceKey === input.preferenceKey &&
            existing.valueJson === input.valueJson &&
            existing.sourceAnswerId === input.sourceAnswerId &&
            existing.createdAtMs === input.createdAtMs &&
            existing.deviceId === input.deviceId &&
            existing.hlcPhysicalMs === input.hlcPhysicalMs &&
            existing.hlcCounter === input.hlcCounter
          ) {
            return existing;
          }
          throw new AthletePlanningContextStoreError("preference-conflict");
        }
        await setAthletePreferenceInTransaction(store, input);
        const created = await readPreference(input.id);
        if (created === undefined) {
          throw new AthletePlanningContextStoreError("preference-conflict");
        }
        return created;
      });
    },
    async removePreference(input) {
      if (
        !ULID.test(input.id) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !Number.isSafeInteger(input.removedAtMs) ||
        input.removedAtMs < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.removedAtMs ||
        !validClock(input)
      ) {
        throw new AthletePlanningContextStoreError("invalid-preference");
      }
      return runTransaction(async () => {
        const current = await readPreference(input.id);
        if (current === undefined) {
          throw new AthletePlanningContextStoreError("missing-preference");
        }
        if (
          current.status !== "active" ||
          current.version !== input.expectedVersion ||
          input.removedAtMs < current.createdAtMs ||
          input.removedAtMs < current.updatedAtMs ||
          input.updatedAtMs < current.updatedAtMs ||
          !clockNotBefore(input, current)
        ) {
          throw new AthletePlanningContextStoreError("stale-preference");
        }
        await store.run(
          `UPDATE athlete_preference SET status='removed',version=version+1,removed_at_ms=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status='active' AND version=?`,
          [
            input.removedAtMs,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.id,
            input.expectedVersion,
          ],
        );
        const removed = await readPreference(input.id);
        if (removed === undefined || removed.status !== "removed") {
          throw new AthletePlanningContextStoreError("stale-preference");
        }
        return removed;
      });
    },
    async createRestriction(input) {
      const record: TrainingRestrictionRecord = {
        ...input,
        status: "active",
        version: 1,
        updatedAtMs: input.createdAtMs,
        endedAtMs: null,
      };
      validateRestriction(record);
      return runTransaction(async () => {
        const existing = await readRestriction(input.id);
        if (existing !== undefined) {
          if (
            existing.status === "active" &&
            existing.kind === input.kind &&
            existing.startDateKey === input.startDateKey &&
            existing.endDateKey === input.endDateKey &&
            existing.maximumDurationMinutes === input.maximumDurationMinutes &&
            existing.confirmedAtMs === input.confirmedAtMs &&
            existing.createdAtMs === input.createdAtMs &&
            existing.deviceId === input.deviceId &&
            existing.hlcPhysicalMs === input.hlcPhysicalMs &&
            existing.hlcCounter === input.hlcCounter
          ) {
            return existing;
          }
          throw new AthletePlanningContextStoreError("restriction-conflict");
        }
        await store.run(
          `INSERT INTO training_restriction (${RESTRICTION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            record.id,
            record.kind,
            record.status,
            record.version,
            record.startDateKey,
            record.endDateKey,
            record.maximumDurationMinutes,
            record.confirmedAtMs,
            record.createdAtMs,
            record.updatedAtMs,
            record.endedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
        const created = await readRestriction(input.id);
        if (created === undefined) {
          throw new AthletePlanningContextStoreError("restriction-conflict");
        }
        return created;
      });
    },
    async endRestriction(input) {
      if (
        !ULID.test(input.id) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !validDateRange(input.endDateKey, input.endDateKey) ||
        !Number.isSafeInteger(input.endedAtMs) ||
        input.endedAtMs < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.endedAtMs ||
        !validClock(input)
      ) {
        throw new AthletePlanningContextStoreError("invalid-restriction");
      }
      return runTransaction(async () => {
        const current = await readRestriction(input.id);
        if (current === undefined) {
          throw new AthletePlanningContextStoreError("missing-restriction");
        }
        if (
          current.status !== "active" ||
          current.version !== input.expectedVersion ||
          !validDateRange(current.startDateKey, input.endDateKey) ||
          input.endedAtMs < current.createdAtMs ||
          input.endedAtMs < current.updatedAtMs ||
          input.updatedAtMs < current.updatedAtMs ||
          !clockNotBefore(input, current)
        ) {
          throw new AthletePlanningContextStoreError("stale-restriction");
        }
        await store.run(
          `UPDATE training_restriction SET status='ended',version=version+1,end_date_key=?,ended_at_ms=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status='active' AND version=?`,
          [
            input.endDateKey,
            input.endedAtMs,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.id,
            input.expectedVersion,
          ],
        );
        const ended = await readRestriction(input.id);
        if (ended === undefined || ended.status !== "ended") {
          throw new AthletePlanningContextStoreError("stale-restriction");
        }
        return ended;
      });
    },
  };
  return Object.freeze(repository);
}

export function createAthletePlanningContextRepository(
  store: AthletePlanningContextStore,
): AthletePlanningContextRepository {
  return buildAthletePlanningContextRepository(store, (operation) => store.transaction(operation));
}

export function createAthletePlanningContextRepositoryInTransaction(
  store: SqlStore,
): AthletePlanningContextRepository {
  return buildAthletePlanningContextRepository(store, (operation) => operation());
}
