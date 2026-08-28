import { canonicalJson } from "../archive/canonical.js";
import type { SqlStore } from "../store/ports.js";
import { addCivilDays } from "./date-keys.js";
import { PlanningRequestStoreError } from "./request-errors.js";
import type { PlanningRequestTerminalResult } from "./request-repository.js";
import type { PlanningRequestAttention } from "./request-repository.js";

export interface PlanningRequestProposalLinkTransactionInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly previousProposalId: string;
  readonly proposalId: string;
  readonly attention: PlanningRequestAttention;
  readonly resolvedDateKey: number | null;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanningRequestCompletionTransactionInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly expectedProposalId: string | null;
  readonly result: PlanningRequestTerminalResult;
  readonly resolvedDateKey: number | null;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new PlanningRequestStoreError("corrupt-record");
  return value;
}

function integerValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanningRequestStoreError("corrupt-record");
  }
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value !== null && typeof value !== "string") {
    throw new PlanningRequestStoreError("corrupt-record");
  }
  return value;
}

function validDateKey(value: number | null): boolean {
  if (value === null) return true;
  try {
    addCivilDays(value, 0);
    return true;
  } catch {
    return false;
  }
}

function requireMutationClock(
  row: Readonly<Record<string, unknown>>,
  input: {
    readonly updatedAtMs: number;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  },
): void {
  const currentUpdatedAtMs = integerValue(row.updated_at_ms);
  const currentPhysicalMs = integerValue(row.hlc_physical_ms);
  const currentCounter = integerValue(row.hlc_counter);
  if (
    !Number.isSafeInteger(input.updatedAtMs) ||
    input.updatedAtMs < currentUpdatedAtMs ||
    !Number.isSafeInteger(input.hlcPhysicalMs) ||
    input.hlcPhysicalMs < currentPhysicalMs ||
    !Number.isSafeInteger(input.hlcCounter) ||
    (input.hlcPhysicalMs === currentPhysicalMs && input.hlcCounter < currentCounter)
  ) {
    throw new PlanningRequestStoreError("invalid-transition");
  }
}

export async function linkPlanningRequestProposalInTransaction(
  store: SqlStore,
  input: PlanningRequestProposalLinkTransactionInput,
): Promise<void> {
  if (!validDateKey(input.resolvedDateKey) || input.attention === "none") {
    throw new PlanningRequestStoreError("invalid-transition");
  }
  const row = await store.get(
    `SELECT lifecycle,proposal_id,revision,updated_at_ms,hlc_physical_ms,hlc_counter
FROM planning_request WHERE request_id=?`,
    [input.requestId],
  );
  if (row === undefined) throw new PlanningRequestStoreError("missing-request");
  if (
    stringValue(row.lifecycle) !== "open" ||
    stringValue(row.proposal_id) !== input.previousProposalId
  ) {
    throw new PlanningRequestStoreError("invalid-transition");
  }
  if (integerValue(row.revision) !== input.expectedRevision) {
    throw new PlanningRequestStoreError("stale-revision");
  }
  requireMutationClock(row, input);
  await store.run(
    `UPDATE planning_request SET proposal_id=?,attention=?,resolved_date_key=?,revision=revision+1,updated_at_ms=?,device_id=?,
hlc_physical_ms=?,hlc_counter=?
WHERE request_id=? AND lifecycle='open' AND proposal_id=? AND revision=?`,
    [
      input.proposalId,
      input.attention,
      input.resolvedDateKey,
      input.updatedAtMs,
      input.deviceId,
      input.hlcPhysicalMs,
      input.hlcCounter,
      input.requestId,
      input.previousProposalId,
      input.expectedRevision,
    ],
  );
  const updated = await store.get(
    "SELECT proposal_id,revision FROM planning_request WHERE request_id=?",
    [input.requestId],
  );
  if (
    updated === undefined ||
    stringValue(updated.proposal_id) !== input.proposalId ||
    integerValue(updated.revision) !== input.expectedRevision + 1
  ) {
    throw new PlanningRequestStoreError("stale-revision");
  }
}

export async function completePlanningRequestInTransaction(
  store: SqlStore,
  input: PlanningRequestCompletionTransactionInput,
): Promise<void> {
  if (!validDateKey(input.resolvedDateKey)) {
    throw new PlanningRequestStoreError("invalid-terminal-result");
  }
  const row = await store.get(
    `SELECT lifecycle,proposal_id,revision,created_at_ms,updated_at_ms,hlc_physical_ms,hlc_counter,
payload_hash FROM planning_request WHERE request_id=?`,
    [input.requestId],
  );
  if (row === undefined) throw new PlanningRequestStoreError("missing-request");
  if (
    stringValue(row.lifecycle) !== "open" ||
    nullableStringValue(row.proposal_id) !== input.expectedProposalId
  ) {
    throw new PlanningRequestStoreError("invalid-transition");
  }
  if (integerValue(row.revision) !== input.expectedRevision) {
    throw new PlanningRequestStoreError("stale-revision");
  }
  requireMutationClock(row, input);
  if (
    input.result.completedAtMs < integerValue(row.created_at_ms) ||
    input.result.completedAtMs > input.updatedAtMs
  ) {
    throw new PlanningRequestStoreError("invalid-terminal-result");
  }
  await store.run(
    `INSERT INTO planning_request_terminal_result (
request_id,result_id,kind,result_json,completed_at_ms,plan_revision_id
) VALUES (?,?,?,?,?,?)`,
    [
      input.requestId,
      input.result.resultId,
      input.result.kind,
      canonicalJson(input.result),
      input.result.completedAtMs,
      input.result.planRevisionId,
    ],
  );
  const tombstone = await store.get(
    "SELECT request_id FROM planning_request_tombstone WHERE request_id=?",
    [input.requestId],
  );
  if (tombstone === undefined) {
    await store.run(
      `INSERT INTO planning_request_tombstone (
request_id,payload_hash,status,created_at_ms,terminal_at_ms
) VALUES (?,?,?,?,?)`,
      [
        input.requestId,
        stringValue(row.payload_hash),
        input.result.kind,
        input.result.completedAtMs,
        input.result.completedAtMs,
      ],
    );
  }
  await store.run(
    `UPDATE planning_request SET lifecycle=?,attention='none',resolved_date_key=?,
revision=revision+1,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE request_id=? AND lifecycle='open' AND proposal_id IS ? AND revision=?`,
    [
      input.result.kind,
      input.resolvedDateKey,
      input.updatedAtMs,
      input.deviceId,
      input.hlcPhysicalMs,
      input.hlcCounter,
      input.requestId,
      input.expectedProposalId,
      input.expectedRevision,
    ],
  );
  const updated = await store.get(
    "SELECT lifecycle,revision FROM planning_request WHERE request_id=?",
    [input.requestId],
  );
  if (
    updated === undefined ||
    stringValue(updated.lifecycle) !== input.result.kind ||
    integerValue(updated.revision) !== input.expectedRevision + 1
  ) {
    throw new PlanningRequestStoreError("stale-revision");
  }
}
