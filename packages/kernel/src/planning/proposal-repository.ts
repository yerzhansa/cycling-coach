import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import {
  encodePlanAdaptationWorkoutSnapshot,
  insertPlanAdaptationLedgerRecord,
  planAdaptationWorkoutSnapshot,
  type PlanAdaptationLedgerRecord,
} from "./adaptation-ledger-repository.js";
import { addCivilDays } from "./date-keys.js";
import type { PlanRecord, PlanWorkoutRecord } from "./repository.js";

export type PlanProposalStatus = "proposed" | "applied" | "rejected" | "superseded" | "refused";
export type PlanProposalConfidence = "Low" | "Moderate" | "High";

export interface PlanProposalRecord {
  readonly id: string;
  readonly planId: string;
  readonly parentProposalId: string | null;
  readonly revision: number;
  readonly status: PlanProposalStatus;
  readonly title: string;
  readonly rationale: string;
  readonly confidence: PlanProposalConfidence;
  readonly mutationJson: string;
  readonly baseSnapshotJson: string;
  readonly refusalReason: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanProposalPremiseRecord {
  readonly id: string;
  readonly proposalId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly sourceDateKey: number | null;
  readonly confidence: PlanProposalConfidence;
  readonly snapshotJson: string;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanProposalRepository {
  save(
    proposal: PlanProposalRecord,
    premises: readonly PlanProposalPremiseRecord[],
  ): Promise<PlanProposalRecord>;
  read(id: string): Promise<PlanProposalRecord | undefined>;
  readOpenForPlan(planId: string): Promise<readonly PlanProposalRecord[]>;
  readPremises(proposalId: string): Promise<readonly PlanProposalPremiseRecord[]>;
  resolve(input: {
    readonly id: string;
    readonly status: "rejected" | "refused";
    readonly reason?: string;
    readonly resolvedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanProposalRecord>;
  apply(input: {
    readonly id: string;
    readonly expectedPlanUpdatedAtMs: number;
    readonly expectedPlanHlcPhysicalMs: number;
    readonly expectedPlanHlcCounter: number;
    readonly expectedWorkouts: readonly PlanWorkoutRecord[];
    readonly mirrorJob: {
      readonly id: string;
      readonly windowStartDateKey: number;
      readonly windowEndDateKey: number;
      readonly createdAtMs: number;
    };
    readonly ledger: PlanAdaptationLedgerRecord;
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly resolvedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanProposalRecord>;
}

export class PlanProposalValidationError extends Error {
  readonly code:
    | "invalid-proposal"
    | "invalid-premise"
    | "missing-proposal"
    | "invalid-transition"
    | "stale-base";

  constructor(code: PlanProposalValidationError["code"]) {
    super(`plan proposal rejected: ${code}`);
    this.name = "PlanProposalValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = new Set<unknown>(["proposed", "applied", "rejected", "superseded", "refused"]);
const CONFIDENCE = new Set<unknown>(["Low", "Moderate", "High"]);

function validJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validDateKey(value: number): boolean {
  try {
    addCivilDays(value, 0);
    return true;
  } catch {
    return false;
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanProposalValidationError("invalid-proposal");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanProposalValidationError("invalid-proposal");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanProposalValidationError("invalid-proposal");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanProposalValidationError("invalid-proposal");
  }
  return value;
}

function validateProposal(record: PlanProposalRecord): void {
  const resolved = record.status !== "proposed";
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    (record.parentProposalId !== null && !ULID.test(record.parentProposalId)) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    !STATUS.has(record.status) ||
    record.title.length === 0 ||
    record.rationale.length === 0 ||
    !CONFIDENCE.has(record.confidence) ||
    !validJson(record.mutationJson) ||
    !validJson(record.baseSnapshotJson) ||
    (record.status === "refused") !== (record.refusalReason !== null) ||
    (record.refusalReason !== null && record.refusalReason.length === 0) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    (record.resolvedAtMs !== null &&
      (!Number.isSafeInteger(record.resolvedAtMs) || record.resolvedAtMs < record.createdAtMs)) ||
    resolved !== (record.resolvedAtMs !== null) ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0
  ) {
    throw new PlanProposalValidationError("invalid-proposal");
  }
}

function validatePremise(record: PlanProposalPremiseRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.proposalId) ||
    record.sourceType.length === 0 ||
    record.sourceId.length === 0 ||
    record.sourceLabel.length === 0 ||
    (record.sourceDateKey !== null && !validDateKey(record.sourceDateKey)) ||
    !CONFIDENCE.has(record.confidence) ||
    !validJson(record.snapshotJson) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0
  ) {
    throw new PlanProposalValidationError("invalid-premise");
  }
}

function proposalFromRow(row: Row): PlanProposalRecord {
  const record: PlanProposalRecord = {
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    parentProposalId: nullableText(row, "parent_proposal_id"),
    revision: integer(row, "revision"),
    status: text(row, "status") as PlanProposalStatus,
    title: text(row, "title"),
    rationale: text(row, "rationale"),
    confidence: text(row, "confidence") as PlanProposalConfidence,
    mutationJson: text(row, "mutation_json"),
    baseSnapshotJson: text(row, "base_snapshot_json"),
    refusalReason: nullableText(row, "refusal_reason"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    resolvedAtMs: nullableInteger(row, "resolved_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validateProposal(record);
  return Object.freeze(record);
}

function premiseFromRow(row: Row): PlanProposalPremiseRecord {
  const record: PlanProposalPremiseRecord = {
    id: text(row, "id"),
    proposalId: text(row, "proposal_id"),
    sourceType: text(row, "source_type"),
    sourceId: text(row, "source_id"),
    sourceLabel: text(row, "source_label"),
    sourceDateKey: nullableInteger(row, "source_date_key"),
    confidence: text(row, "confidence") as PlanProposalConfidence,
    snapshotJson: text(row, "snapshot_json"),
    createdAtMs: integer(row, "created_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validatePremise(record);
  return Object.freeze(record);
}

const PROPOSAL_COLUMNS = `id, plan_id, parent_proposal_id, revision, status, title, rationale,
confidence, mutation_json, base_snapshot_json, refusal_reason, created_at_ms, updated_at_ms,
resolved_at_ms, device_id, hlc_physical_ms, hlc_counter`;
const PREMISE_COLUMNS = `id, proposal_id, source_type, source_id, source_label, source_date_key,
confidence, snapshot_json, created_at_ms, device_id, hlc_physical_ms, hlc_counter`;

type ProposalStore = SqlStore & Pick<MigratorStore, "transaction">;

export function createPlanProposalRepository(store: ProposalStore): PlanProposalRepository {
  const read = async (id: string): Promise<PlanProposalRecord | undefined> => {
    if (!ULID.test(id)) throw new PlanProposalValidationError("invalid-proposal");
    const row = await store.get(`SELECT ${PROPOSAL_COLUMNS} FROM plan_proposal WHERE id=?`, [id]);
    return row === undefined ? undefined : proposalFromRow(row);
  };

  const repository: PlanProposalRepository = Object.freeze({
    async save(proposal: PlanProposalRecord, premises: readonly PlanProposalPremiseRecord[]) {
      validateProposal(proposal);
      if (proposal.status !== "proposed" || premises.length === 0) {
        throw new PlanProposalValidationError("invalid-proposal");
      }
      for (const premise of premises) {
        validatePremise(premise);
        if (premise.proposalId !== proposal.id) {
          throw new PlanProposalValidationError("invalid-premise");
        }
      }
      await store.transaction(async () => {
        if (proposal.parentProposalId !== null) {
          const parentRow = await store.get(
            `SELECT ${PROPOSAL_COLUMNS} FROM plan_proposal WHERE id=?`,
            [proposal.parentProposalId],
          );
          if (parentRow === undefined) throw new PlanProposalValidationError("missing-proposal");
          const parent = proposalFromRow(parentRow);
          if (
            parent.planId !== proposal.planId ||
            parent.status !== "proposed" ||
            proposal.revision !== parent.revision + 1
          ) {
            throw new PlanProposalValidationError("invalid-transition");
          }
          await store.run(
            `UPDATE plan_proposal SET status='superseded', updated_at_ms=?, resolved_at_ms=?,
device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=? AND status='proposed'`,
            [
              proposal.updatedAtMs,
              proposal.updatedAtMs,
              proposal.deviceId,
              proposal.hlcPhysicalMs,
              proposal.hlcCounter,
              parent.id,
            ],
          );
        } else if (proposal.revision !== 1) {
          throw new PlanProposalValidationError("invalid-transition");
        }
        await store.run(
          `INSERT INTO plan_proposal (${PROPOSAL_COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            proposal.id,
            proposal.planId,
            proposal.parentProposalId,
            proposal.revision,
            proposal.status,
            proposal.title,
            proposal.rationale,
            proposal.confidence,
            proposal.mutationJson,
            proposal.baseSnapshotJson,
            proposal.refusalReason,
            proposal.createdAtMs,
            proposal.updatedAtMs,
            proposal.resolvedAtMs,
            proposal.deviceId,
            proposal.hlcPhysicalMs,
            proposal.hlcCounter,
          ],
        );
        for (const premise of premises) {
          await store.run(
            `INSERT INTO plan_proposal_premise (${PREMISE_COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              premise.id,
              premise.proposalId,
              premise.sourceType,
              premise.sourceId,
              premise.sourceLabel,
              premise.sourceDateKey,
              premise.confidence,
              premise.snapshotJson,
              premise.createdAtMs,
              premise.deviceId,
              premise.hlcPhysicalMs,
              premise.hlcCounter,
            ],
          );
        }
      });
      const stored = await read(proposal.id);
      if (stored === undefined) throw new PlanProposalValidationError("missing-proposal");
      return stored;
    },
    read,
    async readOpenForPlan(planId: string) {
      if (!ULID.test(planId)) throw new PlanProposalValidationError("invalid-proposal");
      return (
        await store.all(
          `SELECT ${PROPOSAL_COLUMNS} FROM plan_proposal
WHERE plan_id=? AND status='proposed' ORDER BY created_at_ms DESC,id DESC`,
          [planId],
        )
      ).map(proposalFromRow);
    },
    async readPremises(proposalId: string) {
      if (!ULID.test(proposalId)) throw new PlanProposalValidationError("invalid-proposal");
      return (
        await store.all(
          `SELECT ${PREMISE_COLUMNS} FROM plan_proposal_premise
WHERE proposal_id=? ORDER BY source_type,source_id,id`,
          [proposalId],
        )
      ).map(premiseFromRow);
    },
    async resolve(input: Parameters<PlanProposalRepository["resolve"]>[0]) {
      if (
        !ULID.test(input.id) ||
        (input.status !== "rejected" && input.status !== "refused") ||
        (input.status === "refused" && (input.reason === undefined || input.reason.length === 0)) ||
        !Number.isSafeInteger(input.resolvedAtMs) ||
        input.resolvedAtMs < 0 ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanProposalValidationError("invalid-proposal");
      }
      const current = await read(input.id);
      if (current === undefined) throw new PlanProposalValidationError("missing-proposal");
      if (current.status !== "proposed" || input.resolvedAtMs < current.createdAtMs) {
        throw new PlanProposalValidationError("invalid-transition");
      }
      await store.run(
        `UPDATE plan_proposal SET status=?, refusal_reason=?, updated_at_ms=?, resolved_at_ms=?,
device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=? AND status='proposed'`,
        [
          input.status,
          input.status === "refused" ? input.reason! : null,
          input.resolvedAtMs,
          input.resolvedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
          input.id,
        ],
      );
      const stored = await read(input.id);
      if (stored === undefined || stored.status !== input.status) {
        throw new PlanProposalValidationError("invalid-transition");
      }
      return stored;
    },
    async apply(input: Parameters<PlanProposalRepository["apply"]>[0]) {
      const expectedById = new Map(input.expectedWorkouts.map((workout) => [workout.id, workout]));
      if (
        !ULID.test(input.id) ||
        !ULID.test(input.plan.id) ||
        !Number.isSafeInteger(input.expectedPlanUpdatedAtMs) ||
        input.expectedPlanUpdatedAtMs < 0 ||
        !Number.isSafeInteger(input.expectedPlanHlcPhysicalMs) ||
        input.expectedPlanHlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.expectedPlanHlcCounter) ||
        input.expectedPlanHlcCounter < 0 ||
        !ULID.test(input.mirrorJob.id) ||
        !Number.isSafeInteger(input.mirrorJob.windowStartDateKey) ||
        !Number.isSafeInteger(input.mirrorJob.windowEndDateKey) ||
        input.mirrorJob.windowEndDateKey < input.mirrorJob.windowStartDateKey ||
        !Number.isSafeInteger(input.mirrorJob.createdAtMs) ||
        input.mirrorJob.createdAtMs < 0 ||
        !Number.isSafeInteger(input.resolvedAtMs) ||
        input.resolvedAtMs < 0 ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0 ||
        input.workouts.length === 0 ||
        input.workouts.length !== 1 ||
        input.expectedWorkouts.length !== input.workouts.length ||
        expectedById.size !== input.expectedWorkouts.length ||
        input.workouts.some((workout) => !expectedById.has(workout.id))
      ) {
        throw new PlanProposalValidationError("invalid-proposal");
      }
      const expectedWorkout = input.expectedWorkouts[0]!;
      const nextWorkout = input.workouts[0]!;
      if (
        input.ledger.kind !== "proposal-applied" ||
        input.ledger.sourceId !== input.id ||
        input.ledger.reversalOfId !== null ||
        input.ledger.planId !== input.plan.id ||
        input.ledger.targetWorkoutId !== expectedWorkout.id ||
        input.ledger.beforeJson !==
          encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(expectedWorkout)) ||
        input.ledger.afterJson !==
          encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(nextWorkout))
      ) {
        throw new PlanProposalValidationError("invalid-proposal");
      }
      return store.transaction(async () => {
        const proposalRow = await store.get(
          `SELECT ${PROPOSAL_COLUMNS} FROM plan_proposal WHERE id=?`,
          [input.id],
        );
        if (proposalRow === undefined) throw new PlanProposalValidationError("missing-proposal");
        const proposal = proposalFromRow(proposalRow);
        if (proposal.status !== "proposed" || proposal.planId !== input.plan.id) {
          throw new PlanProposalValidationError("invalid-transition");
        }
        const planRow = await store.get(
          `SELECT updated_at_ms, hlc_physical_ms, hlc_counter FROM plan WHERE id=?`,
          [input.plan.id],
        );
        if (
          planRow === undefined ||
          integer(planRow, "updated_at_ms") !== input.expectedPlanUpdatedAtMs ||
          integer(planRow, "hlc_physical_ms") !== input.expectedPlanHlcPhysicalMs ||
          integer(planRow, "hlc_counter") !== input.expectedPlanHlcCounter
        ) {
          throw new PlanProposalValidationError("stale-base");
        }
        for (const workout of input.workouts) {
          const expected = expectedById.get(workout.id);
          if (
            expected === undefined ||
            workout.planId !== input.plan.id ||
            expected.planId !== input.plan.id ||
            !ULID.test(workout.id)
          ) {
            throw new PlanProposalValidationError("invalid-proposal");
          }
          const current = await store.get(
            `SELECT id, plan_id, date_key, sport, name, duration_s, structure_json, origin,
device_id, hlc_physical_ms, hlc_counter FROM plan_workout WHERE id=? AND plan_id=?`,
            [workout.id, input.plan.id],
          );
          if (
            current === undefined ||
            text(current, "id") !== expected.id ||
            text(current, "plan_id") !== expected.planId ||
            integer(current, "date_key") !== expected.dateKey ||
            text(current, "sport") !== expected.sport ||
            text(current, "name") !== expected.name ||
            nullableInteger(current, "duration_s") !== expected.durationS ||
            text(current, "structure_json") !== expected.structureJson ||
            text(current, "origin") !== expected.origin ||
            text(current, "device_id") !== expected.deviceId ||
            integer(current, "hlc_physical_ms") !== expected.hlcPhysicalMs ||
            integer(current, "hlc_counter") !== expected.hlcCounter
          ) {
            throw new PlanProposalValidationError("stale-base");
          }
          await store.run(
            `UPDATE plan_workout SET date_key=?, sport=?, name=?, duration_s=?, structure_json=?,
origin=?, device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=? AND plan_id=?`,
            [
              workout.dateKey,
              workout.sport,
              workout.name,
              workout.durationS,
              workout.structureJson,
              workout.origin,
              workout.deviceId,
              workout.hlcPhysicalMs,
              workout.hlcCounter,
              workout.id,
              input.plan.id,
            ],
          );
        }
        await store.run(
          `UPDATE plan SET updated_at_ms=?, device_id=?, hlc_physical_ms=?, hlc_counter=?
WHERE id=?`,
          [
            input.plan.updatedAtMs,
            input.plan.deviceId,
            input.plan.hlcPhysicalMs,
            input.plan.hlcCounter,
            input.plan.id,
          ],
        );
        await store.run(
          `UPDATE plan_proposal SET status='applied', updated_at_ms=?, resolved_at_ms=?,
device_id=?, hlc_physical_ms=?, hlc_counter=? WHERE id=? AND status='proposed'`,
          [
            input.resolvedAtMs,
            input.resolvedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.id,
          ],
        );
        await insertPlanAdaptationLedgerRecord(store, input.ledger);
        await store.run(
          `INSERT INTO plan_reconciliation_job (
  id, plan_id, kind, status, window_start_date_key, window_end_date_key,
  attempt_count, failure_count, resumed_count, last_resumed_attempt, last_error_code,
  created_at_ms, updated_at_ms, completed_at_ms
) VALUES (?, ?, 'mirror', 'pending', ?, ?, 0, 0, 0, NULL, NULL, ?, ?, NULL)
ON CONFLICT(plan_id, kind, window_start_date_key, window_end_date_key) DO UPDATE SET
  status='pending', attempt_count=0, failure_count=0, resumed_count=0,
  last_resumed_attempt=NULL, last_error_code=NULL, updated_at_ms=excluded.updated_at_ms,
  completed_at_ms=NULL`,
          [
            input.mirrorJob.id,
            input.plan.id,
            input.mirrorJob.windowStartDateKey,
            input.mirrorJob.windowEndDateKey,
            input.mirrorJob.createdAtMs,
            input.mirrorJob.createdAtMs,
          ],
        );
        const mirrorJobRow = await store.get(
          `SELECT id FROM plan_reconciliation_job
WHERE plan_id=? AND kind='mirror' AND window_start_date_key=? AND window_end_date_key=?`,
          [input.plan.id, input.mirrorJob.windowStartDateKey, input.mirrorJob.windowEndDateKey],
        );
        if (mirrorJobRow === undefined) {
          throw new PlanProposalValidationError("invalid-transition");
        }
        await store.run("DELETE FROM plan_reconciliation_item WHERE job_id=?", [
          text(mirrorJobRow, "id"),
        ]);
        const storedRow = await store.get(
          `SELECT ${PROPOSAL_COLUMNS} FROM plan_proposal WHERE id=?`,
          [input.id],
        );
        if (storedRow === undefined) {
          throw new PlanProposalValidationError("invalid-transition");
        }
        const stored = proposalFromRow(storedRow);
        if (stored.status !== "applied") {
          throw new PlanProposalValidationError("invalid-transition");
        }
        return stored;
      });
    },
  });
  return repository;
}
