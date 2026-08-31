import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import {
  createAthletePlanningContextRepositoryInTransaction,
  setAthletePreferenceInTransaction,
  type AthletePreferenceRecord,
  type CreateAthletePreferenceInput,
} from "./athlete-planning-context-repository.js";

export type PlanCreationStatus = "in-progress" | "review" | "activated" | "discarded";
export type PlanCreationAnswerScope = "plan-creation" | "athlete-preference";

export interface PlanCreationRecord {
  readonly id: string;
  readonly status: PlanCreationStatus;
  readonly version: number;
  readonly seedJson: string | null;
  readonly currentDraftRevisionNumber: number | null;
  readonly activatedPlanId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly terminalAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanCreationAnswerRecord {
  readonly id: string;
  readonly creationId: string;
  readonly sequence: number;
  readonly creationVersion: number;
  readonly answerKey: string;
  readonly valueJson: string;
  readonly scope: PlanCreationAnswerScope;
  readonly preferenceId: string | null;
  readonly confirmedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanCreationDraftRevisionRecord {
  readonly id: string;
  readonly creationId: string;
  readonly revisionNumber: number;
  readonly parentRevisionNumber: number | null;
  readonly inputVersion: number;
  readonly inputSnapshotJson: string;
  readonly inputFingerprint: string;
  readonly builderId: string;
  readonly builderVersion: string;
  readonly outputSnapshotJson: string;
  readonly activationFingerprint: string;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface CreatePlanCreationInput {
  readonly id: string;
  readonly seedJson: string | null;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface RecordPlanCreationAnswerInput {
  readonly id: string;
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly answerKey: string;
  readonly valueJson: string;
  readonly scope: PlanCreationAnswerScope;
  readonly confirmedAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
  readonly preference: CreateAthletePreferenceInput | null;
}

export interface AppendPlanCreationDraftInput {
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
  readonly draft: PlanCreationDraftRevisionRecord;
}

export interface TransitionPlanCreationInput {
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly target: "activated" | "discarded";
  readonly activatedPlanId: string | null;
  readonly terminalAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanCreationAnswerResult {
  readonly creation: PlanCreationRecord;
  readonly answer: PlanCreationAnswerRecord;
  readonly preference: AthletePreferenceRecord | null;
}

export interface PlanCreationRepository {
  createOrReadUnfinished(input: CreatePlanCreationInput): Promise<PlanCreationRecord>;
  read(id: string): Promise<PlanCreationRecord | undefined>;
  readUnfinished(): Promise<PlanCreationRecord | undefined>;
  readAnswer(id: string): Promise<PlanCreationAnswerRecord | undefined>;
  readAnswers(creationId: string): Promise<readonly PlanCreationAnswerRecord[]>;
  readDraftRevision(
    creationId: string,
    revisionNumber: number,
  ): Promise<PlanCreationDraftRevisionRecord | undefined>;
  readDraftRevisions(creationId: string): Promise<readonly PlanCreationDraftRevisionRecord[]>;
  recordAnswer(input: RecordPlanCreationAnswerInput): Promise<PlanCreationAnswerResult>;
  appendDraftRevision(input: AppendPlanCreationDraftInput): Promise<PlanCreationRecord>;
  transition(input: TransitionPlanCreationInput): Promise<PlanCreationRecord>;
}

export type PlanCreationStoreErrorCode =
  | "invalid-creation"
  | "missing-creation"
  | "creation-conflict"
  | "stale-creation"
  | "creation-not-unfinished"
  | "missing-activated-plan"
  | "corrupt-record";

export class PlanCreationStoreError extends Error {
  readonly code: PlanCreationStoreErrorCode;

  constructor(code: PlanCreationStoreErrorCode) {
    super(`Plan Creation rejected: ${code}`);
    this.name = "PlanCreationStoreError";
    this.code = code;
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;
type TransactionRunner = <T>(operation: () => Promise<T>) => Promise<T>;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STATUSES = new Set<unknown>(["in-progress", "review", "activated", "discarded"]);
const CREATION_COLUMNS = `id,status,version,seed_json,current_draft_revision_number,
activated_plan_id,created_at_ms,updated_at_ms,terminal_at_ms,device_id,hlc_physical_ms,hlc_counter`;
const ANSWER_COLUMNS = `id,creation_id,sequence,creation_version,answer_key,value_json,scope,
preference_id,confirmed_at_ms,device_id,hlc_physical_ms,hlc_counter`;
const DRAFT_COLUMNS = `id,creation_id,revision_number,parent_revision_number,input_version,
input_snapshot_json,input_fingerprint,builder_id,builder_version,output_snapshot_json,
activation_fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter`;

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

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanCreationStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanCreationStoreError("corrupt-record");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanCreationStoreError("corrupt-record");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanCreationStoreError("corrupt-record");
  }
  return value;
}

function validateCreation(record: PlanCreationRecord): void {
  const unfinished = record.status === "in-progress" || record.status === "review";
  if (
    !ULID.test(record.id) ||
    !STATUSES.has(record.status) ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0 ||
    (record.seedJson !== null && !validJson(record.seedJson)) ||
    (record.currentDraftRevisionNumber !== null &&
      (!Number.isSafeInteger(record.currentDraftRevisionNumber) ||
        record.currentDraftRevisionNumber <= 0)) ||
    (record.activatedPlanId !== null && !ULID.test(record.activatedPlanId)) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !validClock(record) ||
    unfinished !== (record.terminalAtMs === null) ||
    (record.status === "in-progress" && record.currentDraftRevisionNumber !== null) ||
    (record.status === "review" && record.currentDraftRevisionNumber === null) ||
    (record.status === "activated" &&
      (record.activatedPlanId === null || record.currentDraftRevisionNumber === null)) ||
    (record.status !== "activated" && record.activatedPlanId !== null) ||
    (record.terminalAtMs !== null &&
      (!Number.isSafeInteger(record.terminalAtMs) ||
        record.terminalAtMs < record.createdAtMs ||
        record.terminalAtMs > record.updatedAtMs))
  ) {
    throw new PlanCreationStoreError("invalid-creation");
  }
}

function validateAnswer(record: PlanCreationAnswerRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.creationId) ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence <= 0 ||
    !Number.isSafeInteger(record.creationVersion) ||
    record.creationVersion <= 1 ||
    record.answerKey.length < 1 ||
    record.answerKey.length > 128 ||
    !validJson(record.valueJson) ||
    !["plan-creation", "athlete-preference"].includes(record.scope) ||
    (record.scope === "athlete-preference") !== (record.preferenceId !== null) ||
    (record.preferenceId !== null && !ULID.test(record.preferenceId)) ||
    !Number.isSafeInteger(record.confirmedAtMs) ||
    record.confirmedAtMs < 0 ||
    !validClock(record)
  ) {
    throw new PlanCreationStoreError("invalid-creation");
  }
}

function validateDraft(record: PlanCreationDraftRevisionRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.creationId) ||
    !Number.isSafeInteger(record.revisionNumber) ||
    record.revisionNumber <= 0 ||
    (record.revisionNumber === 1
      ? record.parentRevisionNumber !== null
      : record.parentRevisionNumber !== record.revisionNumber - 1) ||
    !Number.isSafeInteger(record.inputVersion) ||
    record.inputVersion <= 0 ||
    !validJson(record.inputSnapshotJson) ||
    !SHA256.test(record.inputFingerprint) ||
    record.builderId.length < 1 ||
    record.builderId.length > 128 ||
    record.builderVersion.length < 1 ||
    record.builderVersion.length > 128 ||
    !validJson(record.outputSnapshotJson) ||
    !SHA256.test(record.activationFingerprint) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !validClock(record)
  ) {
    throw new PlanCreationStoreError("invalid-creation");
  }
}

function creationFromRow(row: Row): PlanCreationRecord {
  const record: PlanCreationRecord = Object.freeze({
    id: text(row, "id"),
    status: text(row, "status") as PlanCreationStatus,
    version: integer(row, "version"),
    seedJson: nullableText(row, "seed_json"),
    currentDraftRevisionNumber: nullableInteger(row, "current_draft_revision_number"),
    activatedPlanId: nullableText(row, "activated_plan_id"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    terminalAtMs: nullableInteger(row, "terminal_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validateCreation(record);
  } catch {
    throw new PlanCreationStoreError("corrupt-record");
  }
  return record;
}

function answerFromRow(row: Row): PlanCreationAnswerRecord {
  const record: PlanCreationAnswerRecord = Object.freeze({
    id: text(row, "id"),
    creationId: text(row, "creation_id"),
    sequence: integer(row, "sequence"),
    creationVersion: integer(row, "creation_version"),
    answerKey: text(row, "answer_key"),
    valueJson: text(row, "value_json"),
    scope: text(row, "scope") as PlanCreationAnswerScope,
    preferenceId: nullableText(row, "preference_id"),
    confirmedAtMs: integer(row, "confirmed_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validateAnswer(record);
  } catch {
    throw new PlanCreationStoreError("corrupt-record");
  }
  return record;
}

function draftFromRow(row: Row): PlanCreationDraftRevisionRecord {
  const record: PlanCreationDraftRevisionRecord = Object.freeze({
    id: text(row, "id"),
    creationId: text(row, "creation_id"),
    revisionNumber: integer(row, "revision_number"),
    parentRevisionNumber: nullableInteger(row, "parent_revision_number"),
    inputVersion: integer(row, "input_version"),
    inputSnapshotJson: text(row, "input_snapshot_json"),
    inputFingerprint: text(row, "input_fingerprint"),
    builderId: text(row, "builder_id"),
    builderVersion: text(row, "builder_version"),
    outputSnapshotJson: text(row, "output_snapshot_json"),
    activationFingerprint: text(row, "activation_fingerprint"),
    createdAtMs: integer(row, "created_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  try {
    validateDraft(record);
  } catch {
    throw new PlanCreationStoreError("corrupt-record");
  }
  return record;
}

function buildPlanCreationRepository(
  store: SqlStore,
  runTransaction: TransactionRunner,
): PlanCreationRepository {
  const athleteContext = createAthletePlanningContextRepositoryInTransaction(store);
  const read = async (id: string): Promise<PlanCreationRecord | undefined> => {
    if (!ULID.test(id)) throw new PlanCreationStoreError("invalid-creation");
    const row = await store.get(`SELECT ${CREATION_COLUMNS} FROM plan_creation WHERE id=?`, [id]);
    return row === undefined ? undefined : creationFromRow(row);
  };

  const readAnswer = async (id: string): Promise<PlanCreationAnswerRecord | undefined> => {
    if (!ULID.test(id)) throw new PlanCreationStoreError("invalid-creation");
    const row = await store.get(`SELECT ${ANSWER_COLUMNS} FROM plan_creation_answer WHERE id=?`, [
      id,
    ]);
    return row === undefined ? undefined : answerFromRow(row);
  };

  const readDraftRevision = async (
    creationId: string,
    revisionNumber: number,
  ): Promise<PlanCreationDraftRevisionRecord | undefined> => {
    if (!ULID.test(creationId) || !Number.isSafeInteger(revisionNumber) || revisionNumber <= 0) {
      throw new PlanCreationStoreError("invalid-creation");
    }
    const row = await store.get(
      `SELECT ${DRAFT_COLUMNS} FROM plan_creation_draft_revision
WHERE creation_id=? AND revision_number=?`,
      [creationId, revisionNumber],
    );
    return row === undefined ? undefined : draftFromRow(row);
  };

  const readPreference = async (id: string): Promise<AthletePreferenceRecord | null> => {
    return (await athleteContext.readPreference(id)) ?? null;
  };

  const repository: PlanCreationRepository = {
    read,
    readAnswer,
    readDraftRevision,
    async readUnfinished() {
      const rows = await store.all(
        `SELECT ${CREATION_COLUMNS} FROM plan_creation
WHERE status IN ('in-progress','review') ORDER BY created_at_ms ASC,id ASC`,
      );
      if (rows.length > 1) throw new PlanCreationStoreError("corrupt-record");
      return rows[0] === undefined ? undefined : creationFromRow(rows[0]);
    },
    async readAnswers(creationId) {
      if (!ULID.test(creationId)) throw new PlanCreationStoreError("invalid-creation");
      const rows = await store.all(
        `SELECT ${ANSWER_COLUMNS} FROM plan_creation_answer
WHERE creation_id=? ORDER BY sequence ASC,id ASC`,
        [creationId],
      );
      return Object.freeze(rows.map(answerFromRow));
    },
    async readDraftRevisions(creationId) {
      if (!ULID.test(creationId)) throw new PlanCreationStoreError("invalid-creation");
      const rows = await store.all(
        `SELECT ${DRAFT_COLUMNS} FROM plan_creation_draft_revision
WHERE creation_id=? ORDER BY revision_number ASC,id ASC`,
        [creationId],
      );
      return Object.freeze(rows.map(draftFromRow));
    },
    async createOrReadUnfinished(input) {
      const proposed: PlanCreationRecord = {
        ...input,
        status: "in-progress",
        version: 1,
        currentDraftRevisionNumber: null,
        activatedPlanId: null,
        updatedAtMs: input.createdAtMs,
        terminalAtMs: null,
      };
      validateCreation(proposed);
      return runTransaction(async () => {
        const unfinishedRows = await store.all(
          `SELECT ${CREATION_COLUMNS} FROM plan_creation
WHERE status IN ('in-progress','review') ORDER BY created_at_ms ASC,id ASC`,
        );
        if (unfinishedRows.length > 1) throw new PlanCreationStoreError("corrupt-record");
        if (unfinishedRows[0] !== undefined) return creationFromRow(unfinishedRows[0]);
        const sameId = await read(input.id);
        if (sameId !== undefined) throw new PlanCreationStoreError("creation-conflict");
        await store.run(
          `INSERT INTO plan_creation (${CREATION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            proposed.id,
            proposed.status,
            proposed.version,
            proposed.seedJson,
            proposed.currentDraftRevisionNumber,
            proposed.activatedPlanId,
            proposed.createdAtMs,
            proposed.updatedAtMs,
            proposed.terminalAtMs,
            proposed.deviceId,
            proposed.hlcPhysicalMs,
            proposed.hlcCounter,
          ],
        );
        const created = await read(input.id);
        if (created === undefined) throw new PlanCreationStoreError("creation-conflict");
        return created;
      });
    },
    async recordAnswer(input) {
      const preferenceId = input.preference?.id ?? null;
      const draftAnswer: PlanCreationAnswerRecord = {
        id: input.id,
        creationId: input.creationId,
        sequence: 1,
        creationVersion: input.expectedVersion + 1,
        answerKey: input.answerKey,
        valueJson: input.valueJson,
        scope: input.scope,
        preferenceId,
        confirmedAtMs: input.confirmedAtMs,
        deviceId: input.deviceId,
        hlcPhysicalMs: input.hlcPhysicalMs,
        hlcCounter: input.hlcCounter,
      };
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.confirmedAtMs ||
        !validClock(input) ||
        (input.preference !== null &&
          (input.scope !== "athlete-preference" ||
            input.preference.sourceAnswerId !== input.id ||
            input.preference.createdAtMs !== input.confirmedAtMs ||
            input.preference.deviceId !== input.deviceId ||
            input.preference.hlcPhysicalMs !== input.hlcPhysicalMs ||
            input.preference.hlcCounter !== input.hlcCounter)) ||
        (input.preference === null && input.scope !== "plan-creation")
      ) {
        throw new PlanCreationStoreError("invalid-creation");
      }
      validateAnswer(draftAnswer);
      return runTransaction(async () => {
        const existing = await readAnswer(input.id);
        if (existing !== undefined) {
          if (
            existing.creationId !== input.creationId ||
            existing.answerKey !== input.answerKey ||
            existing.valueJson !== input.valueJson ||
            existing.scope !== input.scope ||
            existing.preferenceId !== preferenceId ||
            existing.creationVersion !== input.expectedVersion + 1 ||
            existing.confirmedAtMs !== input.confirmedAtMs ||
            existing.deviceId !== input.deviceId ||
            existing.hlcPhysicalMs !== input.hlcPhysicalMs ||
            existing.hlcCounter !== input.hlcCounter
          ) {
            throw new PlanCreationStoreError("creation-conflict");
          }
          const creation = await read(input.creationId);
          if (creation === undefined) throw new PlanCreationStoreError("corrupt-record");
          const preference = preferenceId === null ? null : await readPreference(preferenceId);
          if (
            input.preference !== null &&
            (preference === null ||
              preference.id !== input.preference.id ||
              preference.preferenceKey !== input.preference.preferenceKey ||
              preference.valueJson !== input.preference.valueJson ||
              preference.status !== "active" ||
              preference.version !== 1 ||
              preference.sourceAnswerId !== input.preference.sourceAnswerId ||
              preference.createdAtMs !== input.preference.createdAtMs ||
              preference.updatedAtMs !== input.preference.createdAtMs ||
              preference.removedAtMs !== null ||
              preference.deviceId !== input.preference.deviceId ||
              preference.hlcPhysicalMs !== input.preference.hlcPhysicalMs ||
              preference.hlcCounter !== input.preference.hlcCounter)
          ) {
            throw new PlanCreationStoreError("creation-conflict");
          }
          return Object.freeze({
            creation,
            answer: existing,
            preference,
          });
        }
        const current = await read(input.creationId);
        if (current === undefined) throw new PlanCreationStoreError("missing-creation");
        if (current.status !== "in-progress" && current.status !== "review") {
          throw new PlanCreationStoreError("creation-not-unfinished");
        }
        if (
          current.version !== input.expectedVersion ||
          input.confirmedAtMs < current.createdAtMs ||
          input.confirmedAtMs < current.updatedAtMs ||
          input.updatedAtMs < current.updatedAtMs ||
          !clockNotBefore(input, current)
        ) {
          throw new PlanCreationStoreError("stale-creation");
        }
        const sequenceRow = await store.get(
          "SELECT COALESCE(MAX(sequence),0) AS sequence FROM plan_creation_answer WHERE creation_id=?",
          [input.creationId],
        );
        const sequence = sequenceRow === undefined ? 1 : integer(sequenceRow, "sequence") + 1;
        const answer: PlanCreationAnswerRecord = { ...draftAnswer, sequence };
        await store.run(
          `INSERT INTO plan_creation_answer (${ANSWER_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            answer.id,
            answer.creationId,
            answer.sequence,
            answer.creationVersion,
            answer.answerKey,
            answer.valueJson,
            answer.scope,
            answer.preferenceId,
            answer.confirmedAtMs,
            answer.deviceId,
            answer.hlcPhysicalMs,
            answer.hlcCounter,
          ],
        );
        if (input.preference !== null) {
          await setAthletePreferenceInTransaction(store, input.preference);
        }
        await store.run(
          `UPDATE plan_creation SET status='in-progress',version=version+1,
current_draft_revision_number=NULL,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?`,
          [
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.creationId,
            input.expectedVersion,
          ],
        );
        const creation = await read(input.creationId);
        if (creation === undefined || creation.version !== input.expectedVersion + 1) {
          throw new PlanCreationStoreError("stale-creation");
        }
        return Object.freeze({
          creation,
          answer,
          preference: preferenceId === null ? null : await readPreference(preferenceId),
        });
      });
    },
    async appendDraftRevision(input) {
      validateDraft(input.draft);
      if (
        input.draft.creationId !== input.creationId ||
        input.draft.inputVersion !== input.expectedVersion ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        !validClock(input)
      ) {
        throw new PlanCreationStoreError("invalid-creation");
      }
      return runTransaction(async () => {
        const current = await read(input.creationId);
        if (current === undefined) throw new PlanCreationStoreError("missing-creation");
        if (current.status !== "in-progress") {
          throw new PlanCreationStoreError("creation-not-unfinished");
        }
        const latestRow = await store.get(
          "SELECT COALESCE(MAX(revision_number),0) AS revision_number FROM plan_creation_draft_revision WHERE creation_id=?",
          [input.creationId],
        );
        const latest = latestRow === undefined ? 0 : integer(latestRow, "revision_number");
        if (
          current.version !== input.expectedVersion ||
          input.draft.revisionNumber !== latest + 1 ||
          input.draft.parentRevisionNumber !== (latest === 0 ? null : latest) ||
          input.draft.createdAtMs < current.updatedAtMs ||
          input.updatedAtMs < input.draft.createdAtMs ||
          !clockNotBefore(input, current) ||
          !clockNotBefore(input.draft, current) ||
          !clockNotBefore(input, input.draft)
        ) {
          throw new PlanCreationStoreError("stale-creation");
        }
        await store.run(
          `INSERT INTO plan_creation_draft_revision (${DRAFT_COLUMNS})
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.draft.id,
            input.creationId,
            input.draft.revisionNumber,
            input.draft.parentRevisionNumber,
            input.draft.inputVersion,
            input.draft.inputSnapshotJson,
            input.draft.inputFingerprint,
            input.draft.builderId,
            input.draft.builderVersion,
            input.draft.outputSnapshotJson,
            input.draft.activationFingerprint,
            input.draft.createdAtMs,
            input.draft.deviceId,
            input.draft.hlcPhysicalMs,
            input.draft.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE plan_creation SET status='review',version=version+1,current_draft_revision_number=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status='in-progress' AND version=?`,
          [
            input.draft.revisionNumber,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.creationId,
            input.expectedVersion,
          ],
        );
        const updated = await read(input.creationId);
        if (updated === undefined || updated.status !== "review") {
          throw new PlanCreationStoreError("stale-creation");
        }
        return updated;
      });
    },
    async transition(input) {
      if (
        !ULID.test(input.creationId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion <= 0 ||
        !["activated", "discarded"].includes(input.target) ||
        (input.target === "activated") !== (input.activatedPlanId !== null) ||
        (input.activatedPlanId !== null && !ULID.test(input.activatedPlanId)) ||
        !Number.isSafeInteger(input.terminalAtMs) ||
        input.terminalAtMs < 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < input.terminalAtMs ||
        !validClock(input)
      ) {
        throw new PlanCreationStoreError("invalid-creation");
      }
      return runTransaction(async () => {
        const current = await read(input.creationId);
        if (current === undefined) throw new PlanCreationStoreError("missing-creation");
        if (current.status === input.target) {
          if (
            current.version === input.expectedVersion + 1 &&
            current.activatedPlanId === input.activatedPlanId &&
            current.terminalAtMs === input.terminalAtMs &&
            current.updatedAtMs === input.updatedAtMs &&
            current.deviceId === input.deviceId &&
            current.hlcPhysicalMs === input.hlcPhysicalMs &&
            current.hlcCounter === input.hlcCounter
          ) {
            return current;
          }
          throw new PlanCreationStoreError("creation-conflict");
        }
        if (
          (current.status !== "in-progress" && current.status !== "review") ||
          current.version !== input.expectedVersion ||
          input.terminalAtMs < current.createdAtMs ||
          input.terminalAtMs < current.updatedAtMs ||
          input.updatedAtMs < current.updatedAtMs ||
          !clockNotBefore(input, current) ||
          (input.target === "activated" && current.status !== "review")
        ) {
          throw new PlanCreationStoreError("stale-creation");
        }
        if (input.activatedPlanId !== null) {
          const activation = await store.get(
            `SELECT aggregate.status,aggregate.current_revision_number,
aggregate.activated_at_ms AS plan_activated_at_ms,
aggregate.updated_at_ms AS plan_updated_at_ms,
aggregate.hlc_physical_ms AS plan_hlc_physical_ms,
aggregate.hlc_counter AS plan_hlc_counter,
revision.source_kind,revision.source_id,revision.snapshot_json,revision.fingerprint,
revision.created_at_ms AS revision_created_at_ms,
revision.hlc_physical_ms AS revision_hlc_physical_ms,
revision.hlc_counter AS revision_hlc_counter,
draft.output_snapshot_json,draft.activation_fingerprint,
draft.created_at_ms AS draft_created_at_ms,
draft.hlc_physical_ms AS draft_hlc_physical_ms,
draft.hlc_counter AS draft_hlc_counter
FROM planning_plan AS aggregate
JOIN plan_revision AS revision
  ON revision.plan_id=aggregate.plan_id
  AND revision.revision_number=aggregate.current_revision_number
JOIN plan_creation_draft_revision AS draft
  ON draft.creation_id=? AND draft.revision_number=?
WHERE aggregate.plan_id=?`,
            [current.id, current.currentDraftRevisionNumber, input.activatedPlanId],
          );
          if (activation === undefined) {
            throw new PlanCreationStoreError("missing-activated-plan");
          }
          if (
            text(activation, "status") !== "active" ||
            integer(activation, "current_revision_number") !== 1 ||
            text(activation, "source_kind") !== "activation" ||
            nullableText(activation, "source_id") !== current.id ||
            text(activation, "snapshot_json") !== text(activation, "output_snapshot_json") ||
            text(activation, "fingerprint") !== text(activation, "activation_fingerprint") ||
            integer(activation, "plan_activated_at_ms") <
              integer(activation, "draft_created_at_ms") ||
            integer(activation, "revision_created_at_ms") <
              integer(activation, "draft_created_at_ms") ||
            !clockNotBefore(
              {
                hlcPhysicalMs: integer(activation, "plan_hlc_physical_ms"),
                hlcCounter: integer(activation, "plan_hlc_counter"),
              },
              {
                hlcPhysicalMs: integer(activation, "draft_hlc_physical_ms"),
                hlcCounter: integer(activation, "draft_hlc_counter"),
              },
            ) ||
            !clockNotBefore(
              {
                hlcPhysicalMs: integer(activation, "revision_hlc_physical_ms"),
                hlcCounter: integer(activation, "revision_hlc_counter"),
              },
              {
                hlcPhysicalMs: integer(activation, "draft_hlc_physical_ms"),
                hlcCounter: integer(activation, "draft_hlc_counter"),
              },
            ) ||
            input.terminalAtMs < integer(activation, "plan_updated_at_ms") ||
            input.terminalAtMs < integer(activation, "revision_created_at_ms") ||
            input.terminalAtMs < integer(activation, "draft_created_at_ms") ||
            !clockNotBefore(input, {
              hlcPhysicalMs: integer(activation, "plan_hlc_physical_ms"),
              hlcCounter: integer(activation, "plan_hlc_counter"),
            }) ||
            !clockNotBefore(input, {
              hlcPhysicalMs: integer(activation, "revision_hlc_physical_ms"),
              hlcCounter: integer(activation, "revision_hlc_counter"),
            }) ||
            !clockNotBefore(input, {
              hlcPhysicalMs: integer(activation, "draft_hlc_physical_ms"),
              hlcCounter: integer(activation, "draft_hlc_counter"),
            })
          ) {
            throw new PlanCreationStoreError("stale-creation");
          }
        }
        await store.run(
          `UPDATE plan_creation SET status=?,version=version+1,activated_plan_id=?,terminal_at_ms=?,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?`,
          [
            input.target,
            input.activatedPlanId,
            input.terminalAtMs,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.creationId,
            input.expectedVersion,
          ],
        );
        const terminal = await read(input.creationId);
        if (terminal === undefined || terminal.status !== input.target) {
          throw new PlanCreationStoreError("stale-creation");
        }
        return terminal;
      });
    },
  };
  return Object.freeze(repository);
}

export function createPlanCreationRepository(store: PlanningStore): PlanCreationRepository {
  return buildPlanCreationRepository(store, (operation) => store.transaction(operation));
}

export function createPlanCreationRepositoryInTransaction(store: SqlStore): PlanCreationRepository {
  return buildPlanCreationRepository(store, (operation) => operation());
}
