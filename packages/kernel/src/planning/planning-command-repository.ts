import { canonicalJson } from "../archive/canonical.js";
import { toHex } from "../archive/paths.js";
import type { CryptoPort } from "../ports/crypto.js";
import { encodeUtf8Strict } from "../store/derived-key.js";
import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";

export const PLANNING_COMMAND_NAMES = [
  "plan_creation.start",
  "plan_creation.answer",
  "plan_creation.preview",
  "plan_creation.activate",
  "plan_creation.discard",
  "plan_change.preview",
  "plan_change.apply",
  "plan.close",
] as const;

export type PlanningCommandName = (typeof PLANNING_COMMAND_NAMES)[number];
export type PlanningCommandStatus = "pending" | "succeeded" | "failed";

export type PlanningCommandJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PlanningCommandJsonValue[]
  | PlanningCommandJsonObject;

export interface PlanningCommandJsonObject {
  readonly [key: string]: PlanningCommandJsonValue;
}

export interface PlanningCommandTerminalError {
  readonly code: string;
  readonly details: PlanningCommandJsonValue;
}

interface PlanningCommandRecordBase {
  readonly commandName: PlanningCommandName;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly aggregateRefs: PlanningCommandJsonObject;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export type PendingPlanningCommandRecord = PlanningCommandRecordBase & {
  readonly status: "pending";
  readonly result: null;
  readonly error: null;
};

export type SucceededPlanningCommandRecord = PlanningCommandRecordBase & {
  readonly status: "succeeded";
  readonly result: PlanningCommandJsonObject;
  readonly error: null;
};

export type FailedPlanningCommandRecord = PlanningCommandRecordBase & {
  readonly status: "failed";
  readonly result: null;
  readonly error: PlanningCommandTerminalError;
};

export type TerminalPlanningCommandRecord =
  | SucceededPlanningCommandRecord
  | FailedPlanningCommandRecord;

export type PlanningCommandRecord = PendingPlanningCommandRecord | TerminalPlanningCommandRecord;

export type PlanningCommandCompletion =
  | {
      readonly status: "succeeded";
      readonly result: PlanningCommandJsonObject;
    }
  | {
      readonly status: "failed";
      readonly error: PlanningCommandTerminalError;
    };

export interface ClaimPlanningCommandTransactionInput {
  readonly commandName: PlanningCommandName;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly aggregateRefs: PlanningCommandJsonObject;
  readonly createdAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface ClaimPlanningCommandInput extends Omit<
  ClaimPlanningCommandTransactionInput,
  "requestDigest"
> {
  readonly request: PlanningCommandJsonObject;
}

export interface CompletePlanningCommandInput {
  readonly commandName: PlanningCommandName;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly expectedVersion: number;
  readonly completion: PlanningCommandCompletion;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export type PlanningCommandClaim =
  | {
      readonly outcome: "claimed";
      readonly command: PendingPlanningCommandRecord;
    }
  | {
      readonly outcome: "pending";
      readonly command: PendingPlanningCommandRecord;
    }
  | {
      readonly outcome: "replayed";
      readonly command: TerminalPlanningCommandRecord;
    };

export type PlanningCommandStoreErrorCode =
  | "invalid-command"
  | "command-conflict"
  | "missing-command"
  | "stale-command"
  | "immutable-terminal"
  | "corrupt-record";

export class PlanningCommandStoreError extends Error {
  readonly code: PlanningCommandStoreErrorCode;

  constructor(code: PlanningCommandStoreErrorCode) {
    super(`Planning command rejected: ${code}`);
    this.name = "PlanningCommandStoreError";
    this.code = code;
  }
}

export interface PlanningCommandRepository {
  read(
    commandName: PlanningCommandName,
    commandId: string,
  ): Promise<PlanningCommandRecord | undefined>;
  claim(input: ClaimPlanningCommandInput): Promise<PlanningCommandClaim>;
  complete(input: CompletePlanningCommandInput): Promise<TerminalPlanningCommandRecord>;
}

type PlanningCommandStore = SqlStore & Pick<MigratorStore, "transaction">;

const COMMAND_NAMES = new Set<unknown>(PLANNING_COMMAND_NAMES);
const ID = /^.{1,512}$/su;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is PlanningCommandJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = true;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) {
        valid = false;
        break;
      }
    }
  } else if (isPlainObject(value)) {
    valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  } else {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is PlanningCommandJsonObject {
  return isPlainObject(value) && isJsonValue(value);
}

function validKey(commandName: unknown, commandId: unknown): boolean {
  return COMMAND_NAMES.has(commandName) && typeof commandId === "string" && ID.test(commandId);
}

function validClock(input: {
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}): boolean {
  return (
    (input.createdAtMs === undefined ||
      (Number.isSafeInteger(input.createdAtMs) && input.createdAtMs >= 0)) &&
    (input.updatedAtMs === undefined ||
      (Number.isSafeInteger(input.updatedAtMs) && input.updatedAtMs >= 0)) &&
    DEVICE_ID.test(input.deviceId) &&
    Number.isSafeInteger(input.hlcPhysicalMs) &&
    input.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(input.hlcCounter) &&
    input.hlcCounter >= 0
  );
}

function validTerminalError(value: unknown): value is PlanningCommandTerminalError {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "code") &&
    Object.hasOwn(value, "details") &&
    typeof value.code === "string" &&
    ERROR_CODE.test(value.code) &&
    isJsonValue(value.details)
  );
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanningCommandStoreError("corrupt-record");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanningCommandStoreError("corrupt-record");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanningCommandStoreError("corrupt-record");
  }
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PlanningCommandStoreError("corrupt-record");
  }
}

export function canonicalizePlanningCommandRequest(value: unknown): string {
  if (!isJsonObject(value)) throw new PlanningCommandStoreError("invalid-command");
  return canonicalJson(value);
}

export async function hashPlanningCommandRequest(
  crypto: CryptoPort,
  value: unknown,
): Promise<string> {
  return toHex(await crypto.sha256(encodeUtf8Strict(canonicalizePlanningCommandRequest(value))));
}

async function readPlanningCommand(
  store: Pick<SqlStore, "get">,
  commandName: PlanningCommandName,
  commandId: string,
): Promise<PlanningCommandRecord | undefined> {
  if (!validKey(commandName, commandId)) {
    throw new PlanningCommandStoreError("invalid-command");
  }
  const row = await store.get(
    `SELECT command_name,command_id,request_digest,status,aggregate_refs_json,result_json,
error_code,error_json,version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
FROM planning_command WHERE command_name=? AND command_id=?`,
    [commandName, commandId],
  );
  if (row === undefined) return undefined;
  const storedName = text(row, "command_name");
  const storedId = text(row, "command_id");
  const requestDigest = text(row, "request_digest");
  const status = text(row, "status");
  const aggregateRefs = parseJson(text(row, "aggregate_refs_json"));
  const resultJson = nullableText(row, "result_json");
  const errorCode = nullableText(row, "error_code");
  const errorJson = nullableText(row, "error_json");
  const version = integer(row, "version");
  const createdAtMs = integer(row, "created_at_ms");
  const updatedAtMs = integer(row, "updated_at_ms");
  const deviceId = text(row, "device_id");
  const hlcPhysicalMs = integer(row, "hlc_physical_ms");
  const hlcCounter = integer(row, "hlc_counter");
  if (
    storedName !== commandName ||
    storedId !== commandId ||
    !validKey(storedName, storedId) ||
    !SHA256.test(requestDigest) ||
    !isJsonObject(aggregateRefs) ||
    !validClock({ updatedAtMs, deviceId, hlcPhysicalMs, hlcCounter }) ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    updatedAtMs < createdAtMs
  ) {
    throw new PlanningCommandStoreError("corrupt-record");
  }
  const base = {
    commandName,
    commandId,
    requestDigest,
    aggregateRefs,
    version,
    createdAtMs,
    updatedAtMs,
    deviceId,
    hlcPhysicalMs,
    hlcCounter,
  };
  if (status === "pending") {
    if (version !== 1 || resultJson !== null || errorCode !== null || errorJson !== null) {
      throw new PlanningCommandStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, status, result: null, error: null });
  }
  if (status === "succeeded") {
    const result = resultJson === null ? undefined : parseJson(resultJson);
    if (version !== 2 || !isJsonObject(result) || errorCode !== null || errorJson !== null) {
      throw new PlanningCommandStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, status, result, error: null });
  }
  if (status === "failed") {
    const error = errorJson === null ? undefined : parseJson(errorJson);
    if (
      version !== 2 ||
      resultJson !== null ||
      errorCode === null ||
      !validTerminalError(error) ||
      error.code !== errorCode
    ) {
      throw new PlanningCommandStoreError("corrupt-record");
    }
    return Object.freeze({ ...base, status, result: null, error });
  }
  throw new PlanningCommandStoreError("corrupt-record");
}

function validateClaimInput(input: ClaimPlanningCommandTransactionInput): void {
  if (
    !validKey(input.commandName, input.commandId) ||
    !SHA256.test(input.requestDigest) ||
    !isJsonObject(input.aggregateRefs) ||
    !validClock(input) ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0
  ) {
    throw new PlanningCommandStoreError("invalid-command");
  }
}

function validateCompletionInput(input: CompletePlanningCommandInput): void {
  const validCompletion =
    input.completion.status === "succeeded"
      ? isJsonObject(input.completion.result)
      : validTerminalError(input.completion.error);
  if (
    !validKey(input.commandName, input.commandId) ||
    !SHA256.test(input.requestDigest) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !validCompletion ||
    !validClock(input) ||
    !Number.isSafeInteger(input.updatedAtMs) ||
    input.updatedAtMs < 0
  ) {
    throw new PlanningCommandStoreError("invalid-command");
  }
}

function sameCompletion(
  command: TerminalPlanningCommandRecord,
  completion: PlanningCommandCompletion,
): boolean {
  if (command.status !== completion.status) return false;
  return command.status === "succeeded" && completion.status === "succeeded"
    ? canonicalJson(command.result) === canonicalJson(completion.result)
    : command.status === "failed" && completion.status === "failed"
      ? canonicalJson(command.error) === canonicalJson(completion.error)
      : false;
}

export async function claimPlanningCommandInTransaction(
  store: SqlStore,
  input: ClaimPlanningCommandTransactionInput,
): Promise<PlanningCommandClaim> {
  validateClaimInput(input);
  const current = await readPlanningCommand(store, input.commandName, input.commandId);
  if (current !== undefined) {
    if (current.requestDigest !== input.requestDigest) {
      throw new PlanningCommandStoreError("command-conflict");
    }
    return current.status === "pending"
      ? Object.freeze({ outcome: "pending", command: current })
      : Object.freeze({ outcome: "replayed", command: current });
  }
  await store.run(
    `INSERT INTO planning_command (
command_name,command_id,request_digest,status,aggregate_refs_json,result_json,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,'pending',?,NULL,NULL,NULL,1,?,?,?,?,?)`,
    [
      input.commandName,
      input.commandId,
      input.requestDigest,
      canonicalJson(input.aggregateRefs),
      input.createdAtMs,
      input.createdAtMs,
      input.deviceId,
      input.hlcPhysicalMs,
      input.hlcCounter,
    ],
  );
  const claimed = await readPlanningCommand(store, input.commandName, input.commandId);
  if (claimed?.status !== "pending" || claimed.requestDigest !== input.requestDigest) {
    throw new PlanningCommandStoreError("corrupt-record");
  }
  return Object.freeze({ outcome: "claimed", command: claimed });
}

export async function completePlanningCommandInTransaction(
  store: SqlStore,
  input: CompletePlanningCommandInput,
): Promise<TerminalPlanningCommandRecord> {
  validateCompletionInput(input);
  const current = await readPlanningCommand(store, input.commandName, input.commandId);
  if (current === undefined) throw new PlanningCommandStoreError("missing-command");
  if (current.requestDigest !== input.requestDigest) {
    throw new PlanningCommandStoreError("command-conflict");
  }
  if (current.status !== "pending") {
    if (sameCompletion(current, input.completion)) return current;
    throw new PlanningCommandStoreError("immutable-terminal");
  }
  if (current.version !== input.expectedVersion) {
    throw new PlanningCommandStoreError("stale-command");
  }
  if (
    input.updatedAtMs < current.updatedAtMs ||
    input.hlcPhysicalMs < current.hlcPhysicalMs ||
    (input.hlcPhysicalMs === current.hlcPhysicalMs && input.hlcCounter < current.hlcCounter)
  ) {
    throw new PlanningCommandStoreError("invalid-command");
  }
  const resultJson =
    input.completion.status === "succeeded" ? canonicalJson(input.completion.result) : null;
  const errorCode = input.completion.status === "failed" ? input.completion.error.code : null;
  const errorJson =
    input.completion.status === "failed" ? canonicalJson(input.completion.error) : null;
  await store.run(
    `UPDATE planning_command SET status=?,result_json=?,error_code=?,error_json=?,version=version+1,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE command_name=? AND command_id=? AND request_digest=? AND status='pending' AND version=?`,
    [
      input.completion.status,
      resultJson,
      errorCode,
      errorJson,
      input.updatedAtMs,
      input.deviceId,
      input.hlcPhysicalMs,
      input.hlcCounter,
      input.commandName,
      input.commandId,
      input.requestDigest,
      input.expectedVersion,
    ],
  );
  const completed = await readPlanningCommand(store, input.commandName, input.commandId);
  if (
    completed === undefined ||
    completed.status === "pending" ||
    !sameCompletion(completed, input.completion)
  ) {
    throw new PlanningCommandStoreError("stale-command");
  }
  return completed;
}

export function createPlanningCommandRepository(
  store: PlanningCommandStore,
  crypto: CryptoPort,
): PlanningCommandRepository {
  const repository: PlanningCommandRepository = {
    read: (commandName, commandId) => readPlanningCommand(store, commandName, commandId),
    async claim(input) {
      const requestDigest = await hashPlanningCommandRequest(crypto, input.request);
      return store.transaction(() =>
        claimPlanningCommandInTransaction(store, { ...input, requestDigest }),
      );
    },
    complete: (input) =>
      store.transaction(() => completePlanningCommandInTransaction(store, input)),
  };
  return Object.freeze(repository);
}
