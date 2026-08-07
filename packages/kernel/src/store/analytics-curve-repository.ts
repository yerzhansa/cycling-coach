import type { Row, SqlStore } from "./ports.js";

export const ANALYTICS_CURVE_PARTS = Object.freeze([
  Object.freeze({ curveFamily: "power" as const, activityType: "Ride" as const }),
  Object.freeze({ curveFamily: "power" as const, activityType: "VirtualRide" as const }),
  Object.freeze({ curveFamily: "heart-rate" as const, activityType: "Ride" as const }),
  Object.freeze({ curveFamily: "heart-rate" as const, activityType: "VirtualRide" as const }),
]);

export const ANALYTICS_CURVE_REFRESH_FAILURE_CODES = Object.freeze([
  "request-budget-exhausted",
  "rate-limited",
  "timeout",
  "network",
  "provider-unavailable",
  "malformed-response",
  "response-too-large",
  "cancelled",
  "temporary-failure",
] as const);

export type AnalyticsCurveFamily = (typeof ANALYTICS_CURVE_PARTS)[number]["curveFamily"];
export type AnalyticsCurveActivityType = (typeof ANALYTICS_CURVE_PARTS)[number]["activityType"];
export type AnalyticsCurveRefreshFailureCode =
  (typeof ANALYTICS_CURVE_REFRESH_FAILURE_CODES)[number];

export interface AnalyticsCurveWindows {
  readonly current: { readonly start: string; readonly end: string };
  readonly previous: { readonly start: string; readonly end: string };
  readonly sustainability: { readonly start: string; readonly end: string };
}

export interface AnalyticsCurveGeneration {
  readonly generationId: string;
  readonly frozenEpochSeconds: number;
  readonly frozenOn: string;
  readonly windows: AnalyticsCurveWindows;
}

export interface AnalyticsCurveEvidence {
  readonly evidenceId: string;
  readonly generationId: string;
  readonly curveFamily: AnalyticsCurveFamily;
  readonly activityType: AnalyticsCurveActivityType;
  readonly requestIdentity: string;
  readonly archiveAddress: string;
  readonly archiveRelPath: string;
  readonly archiveEpochSeconds: number;
  readonly decodedBytes: number;
}

export interface AnalyticsCurveRefreshFailure {
  readonly generationId: string;
  readonly code: AnalyticsCurveRefreshFailureCode;
  readonly failedEpochSeconds: number;
}

export interface AnalyticsCurveState {
  readonly current: null | {
    readonly generation: AnalyticsCurveGeneration;
    readonly evidence: readonly AnalyticsCurveEvidence[];
    readonly promotedEpochSeconds: number;
  };
  readonly refreshFailure: AnalyticsCurveRefreshFailure | null;
}

export interface AnalyticsCurveRepository {
  beginGeneration(input: {
    readonly frozenEpochSeconds: number;
    readonly frozenOn: string;
  }): Promise<{ readonly generation: AnalyticsCurveGeneration; readonly inserted: boolean }>;
  recordEvidence(input: {
    readonly generationId: string;
    readonly curveFamily: AnalyticsCurveFamily;
    readonly activityType: AnalyticsCurveActivityType;
    readonly archiveAddress: string;
    readonly archiveRelPath: string;
    readonly archiveEpochSeconds: number;
    readonly decodedBytes: number;
  }): Promise<{ readonly evidence: AnalyticsCurveEvidence; readonly inserted: boolean }>;
  promoteGeneration(input: {
    readonly generationId: string;
    readonly promotedEpochSeconds: number;
  }): Promise<"promoted" | "already-current" | "reselected-current">;
  recordRefreshFailure(input: AnalyticsCurveRefreshFailure): Promise<void>;
  readState(): Promise<AnalyticsCurveState>;
}

type HashKey = (fields: readonly (string | number)[]) => Promise<string>;

const HEX = /^[0-9a-f]{64}$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EPOCH_SECONDS = 8_640_000_000_000;
const MAX_DECODED_BYTES = 2_097_152;

function invalidInput(): never {
  throw new TypeError("invalid analytics curve input");
}

function invariantMismatch(): never {
  throw new Error("analytics curve invariant mismatch");
}

function isPlainExact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string" && keys.includes(key))
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= MAX_EPOCH_SECONDS;
}

function civilDate(value: unknown): string {
  if (typeof value !== "string" || !CIVIL_DATE.test(value)) invalidInput();
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day || parsed.toISOString().slice(0, 10) !== value) invalidInput();
  return value;
}

function shiftCivilDate(value: string, days: number): string {
  civilDate(value);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function analyticsCurveWindows(frozenOn: string): AnalyticsCurveWindows {
  const date = civilDate(frozenOn);
  return Object.freeze({
    current: Object.freeze({ start: shiftCivilDate(date, -27), end: date }),
    previous: Object.freeze({ start: shiftCivilDate(date, -55), end: shiftCivilDate(date, -28) }),
    sustainability: Object.freeze({ start: shiftCivilDate(date, -41), end: date }),
  });
}

function generationFields(generation: AnalyticsCurveGeneration): readonly (string | number)[] {
  return [
    "analytics_curve_generation",
    "intervals-icu",
    "analytics-curves",
    generation.frozenEpochSeconds,
    generation.frozenOn,
    generation.windows.current.start,
    generation.windows.current.end,
    generation.windows.previous.start,
    generation.windows.previous.end,
    generation.windows.sustainability.start,
    generation.windows.sustainability.end,
  ];
}

function requestFields(
  generation: AnalyticsCurveGeneration,
  curveFamily: AnalyticsCurveFamily,
  activityType: AnalyticsCurveActivityType,
): readonly (string | number)[] {
  return [
    "analytics_curve_request",
    curveFamily,
    activityType,
    `r.${generation.windows.current.start}.${generation.windows.current.end}`,
    `r.${generation.windows.previous.start}.${generation.windows.previous.end}`,
    `r.${generation.windows.sustainability.start}.${generation.windows.sustainability.end}`,
  ];
}

function isCurveFamily(value: unknown): value is AnalyticsCurveFamily {
  return value === "power" || value === "heart-rate";
}

function isCurveActivityType(value: unknown): value is AnalyticsCurveActivityType {
  return value === "Ride" || value === "VirtualRide";
}

function isCurvePart(curveFamily: unknown, activityType: unknown): boolean {
  return isCurveFamily(curveFamily) && isCurveActivityType(activityType);
}

function isRefreshFailureCode(value: unknown): value is AnalyticsCurveRefreshFailureCode {
  return (ANALYTICS_CURVE_REFRESH_FAILURE_CODES as readonly unknown[]).includes(value);
}

function archivePath(value: unknown, address: string, epochSeconds: number): value is string {
  if (typeof value !== "string") return false;
  const prefix = new Date(epochSeconds * 1_000).toISOString().slice(0, 7).replace("-", "/");
  return value === `${prefix}/${address}.json.gz`;
}

function generationFromRow(row: Row | undefined): AnalyticsCurveGeneration {
  if (row === undefined || !isAddress(row.generation_id) || row.source !== "intervals-icu"
    || row.lane !== "analytics-curves" || !isEpoch(row.frozen_epoch_s)
    || typeof row.frozen_on !== "string" || typeof row.current_start !== "string"
    || typeof row.current_end !== "string" || typeof row.previous_start !== "string"
    || typeof row.previous_end !== "string" || typeof row.sustainability_start !== "string"
    || typeof row.sustainability_end !== "string") invariantMismatch();
  let windows: AnalyticsCurveWindows;
  try {
    windows = analyticsCurveWindows(row.frozen_on);
  } catch {
    invariantMismatch();
  }
  if (row.current_start !== windows.current.start || row.current_end !== windows.current.end
    || row.previous_start !== windows.previous.start || row.previous_end !== windows.previous.end
    || row.sustainability_start !== windows.sustainability.start
    || row.sustainability_end !== windows.sustainability.end
    || new Date(row.frozen_epoch_s * 1_000).toISOString().slice(0, 10) !== row.frozen_on) {
    invariantMismatch();
  }
  return Object.freeze({
    generationId: row.generation_id,
    frozenEpochSeconds: row.frozen_epoch_s,
    frozenOn: row.frozen_on,
    windows,
  });
}

function evidenceFromRow(row: Row): AnalyticsCurveEvidence {
  if (!isAddress(row.evidence_id) || !isAddress(row.generation_id)
    || !isCurvePart(row.curve_family, row.activity_type) || !isAddress(row.request_identity)
    || !isAddress(row.archive_address) || !isEpoch(row.archive_epoch_s)
    || !archivePath(row.archive_rel_path, row.archive_address, row.archive_epoch_s)
    || typeof row.decoded_bytes !== "number" || !Number.isSafeInteger(row.decoded_bytes)
    || row.decoded_bytes < 1 || row.decoded_bytes > MAX_DECODED_BYTES) invariantMismatch();
  return Object.freeze({
    evidenceId: row.evidence_id,
    generationId: row.generation_id,
    curveFamily: row.curve_family as AnalyticsCurveFamily,
    activityType: row.activity_type as AnalyticsCurveActivityType,
    requestIdentity: row.request_identity,
    archiveAddress: row.archive_address,
    archiveRelPath: row.archive_rel_path,
    archiveEpochSeconds: row.archive_epoch_s,
    decodedBytes: row.decoded_bytes,
  });
}

function sameGeneration(left: AnalyticsCurveGeneration, right: AnalyticsCurveGeneration): boolean {
  return left.generationId === right.generationId
    && left.frozenEpochSeconds === right.frozenEpochSeconds
    && left.frozenOn === right.frozenOn
    && left.windows.current.start === right.windows.current.start
    && left.windows.current.end === right.windows.current.end
    && left.windows.previous.start === right.windows.previous.start
    && left.windows.previous.end === right.windows.previous.end
    && left.windows.sustainability.start === right.windows.sustainability.start
    && left.windows.sustainability.end === right.windows.sustainability.end;
}

function sameEvidence(left: AnalyticsCurveEvidence, right: AnalyticsCurveEvidence): boolean {
  return left.evidenceId === right.evidenceId
    && left.generationId === right.generationId
    && left.curveFamily === right.curveFamily
    && left.activityType === right.activityType
    && left.requestIdentity === right.requestIdentity
    && left.archiveAddress === right.archiveAddress
    && left.archiveRelPath === right.archiveRelPath
    && left.archiveEpochSeconds === right.archiveEpochSeconds
    && left.decodedBytes === right.decodedBytes;
}

function isCompleteEvidence(evidence: readonly AnalyticsCurveEvidence[]): boolean {
  return evidence.length === ANALYTICS_CURVE_PARTS.length
    && ANALYTICS_CURVE_PARTS.every((part) => evidence.some((row) =>
      row.curveFamily === part.curveFamily && row.activityType === part.activityType));
}

const GENERATION_COLUMNS = `generation_id,source,lane,frozen_epoch_s,frozen_on,
  current_start,current_end,previous_start,previous_end,sustainability_start,sustainability_end`;
const EVIDENCE_COLUMNS = `evidence_id,generation_id,curve_family,activity_type,request_identity,
  archive_address,archive_rel_path,archive_epoch_s,decoded_bytes`;

export function createAnalyticsCurveRepository(
  store: SqlStore,
  hashKey: HashKey,
): AnalyticsCurveRepository {
  if (store === null || typeof store !== "object" || typeof hashKey !== "function") invalidInput();

  const readGeneration = async (generationId: string): Promise<AnalyticsCurveGeneration> => {
    const generation = generationFromRow(await store.get(
      `SELECT ${GENERATION_COLUMNS} FROM analytics_curve_generation WHERE generation_id=?`,
      [generationId],
    ));
    if (generation.generationId !== generationId
      || await hashKey(generationFields(generation)) !== generationId) invariantMismatch();
    return generation;
  };

  const readEvidence = async (
    generation: AnalyticsCurveGeneration,
  ): Promise<readonly AnalyticsCurveEvidence[]> => {
    const evidence = (await store.all(`SELECT ${EVIDENCE_COLUMNS}
FROM analytics_curve_evidence
WHERE generation_id=?
ORDER BY curve_family COLLATE BINARY ASC, activity_type COLLATE BINARY ASC`, [generation.generationId]))
      .map(evidenceFromRow);
    for (const row of evidence) {
      const requestIdentity = await hashKey(requestFields(
        generation,
        row.curveFamily,
        row.activityType,
      ));
      const evidenceId = await hashKey(["analytics_curve_evidence", requestIdentity,
        row.archiveAddress, row.archiveRelPath, row.archiveEpochSeconds, row.decodedBytes]);
      if (row.generationId !== generation.generationId
        || row.archiveEpochSeconds !== generation.frozenEpochSeconds
        || row.requestIdentity !== requestIdentity || row.evidenceId !== evidenceId) invariantMismatch();
    }
    return evidence;
  };

  const repository: AnalyticsCurveRepository = {
    async beginGeneration(input) {
      if (!isPlainExact(input, ["frozenEpochSeconds", "frozenOn"])
        || !isEpoch(input.frozenEpochSeconds)) invalidInput();
      const frozenOn = civilDate(input.frozenOn);
      if (new Date(input.frozenEpochSeconds * 1_000).toISOString().slice(0, 10) !== frozenOn) {
        invalidInput();
      }
      const seed: AnalyticsCurveGeneration = {
        generationId: "0".repeat(64),
        frozenEpochSeconds: input.frozenEpochSeconds,
        frozenOn,
        windows: analyticsCurveWindows(frozenOn),
      };
      const generationId = await hashKey(generationFields(seed));
      if (!isAddress(generationId)) invalidInput();
      const generation = Object.freeze({ ...seed, generationId });
      const values = [generationId, "intervals-icu", "analytics-curves", input.frozenEpochSeconds,
        frozenOn, generation.windows.current.start, generation.windows.current.end,
        generation.windows.previous.start, generation.windows.previous.end,
        generation.windows.sustainability.start, generation.windows.sustainability.end] as const;
      const inserted = await store.get(`INSERT INTO analytics_curve_generation (
  generation_id,source,lane,frozen_epoch_s,frozen_on,current_start,current_end,
  previous_start,previous_end,sustainability_start,sustainability_end
) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING generation_id`, values);
      const byId = generationFromRow(await store.get(
        `SELECT ${GENERATION_COLUMNS} FROM analytics_curve_generation WHERE generation_id=?`,
        [generationId],
      ));
      const byTuple = generationFromRow(await store.get(`SELECT ${GENERATION_COLUMNS}
FROM analytics_curve_generation
WHERE frozen_epoch_s=? AND current_start=? AND current_end=? AND previous_start=?
  AND previous_end=? AND sustainability_start=? AND sustainability_end=?`, [
        input.frozenEpochSeconds, generation.windows.current.start, generation.windows.current.end,
        generation.windows.previous.start, generation.windows.previous.end,
        generation.windows.sustainability.start, generation.windows.sustainability.end,
      ]));
      if (!sameGeneration(byId, generation) || !sameGeneration(byTuple, generation)) {
        invariantMismatch();
      }
      return Object.freeze({ generation, inserted: inserted !== undefined });
    },

    async recordEvidence(input) {
      if (!isPlainExact(input, ["generationId", "curveFamily", "activityType", "archiveAddress",
        "archiveRelPath", "archiveEpochSeconds", "decodedBytes"])
        || !isAddress(input.generationId) || !isCurvePart(input.curveFamily, input.activityType)
        || !isAddress(input.archiveAddress) || !isEpoch(input.archiveEpochSeconds)
        || !archivePath(input.archiveRelPath, input.archiveAddress, input.archiveEpochSeconds)
        || !Number.isSafeInteger(input.decodedBytes) || input.decodedBytes < 1
        || input.decodedBytes > MAX_DECODED_BYTES) invalidInput();
      const generation = await readGeneration(input.generationId);
      if (input.archiveEpochSeconds !== generation.frozenEpochSeconds) invalidInput();
      const requestIdentity = await hashKey(requestFields(
        generation,
        input.curveFamily,
        input.activityType,
      ));
      if (!isAddress(requestIdentity)) invalidInput();
      const evidenceId = await hashKey(["analytics_curve_evidence", requestIdentity,
        input.archiveAddress, input.archiveRelPath, input.archiveEpochSeconds, input.decodedBytes]);
      if (!isAddress(evidenceId)) invalidInput();
      const values = [evidenceId, input.generationId, input.curveFamily, input.activityType,
        requestIdentity, input.archiveAddress, input.archiveRelPath, input.archiveEpochSeconds,
        input.decodedBytes] as const;
      const inserted = await store.get(`INSERT INTO analytics_curve_evidence (
  evidence_id,generation_id,curve_family,activity_type,request_identity,
  archive_address,archive_rel_path,archive_epoch_s,decoded_bytes
) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING evidence_id`, values);
      const expected: AnalyticsCurveEvidence = {
        evidenceId,
        generationId: input.generationId,
        curveFamily: input.curveFamily,
        activityType: input.activityType,
        requestIdentity,
        archiveAddress: input.archiveAddress,
        archiveRelPath: input.archiveRelPath,
        archiveEpochSeconds: input.archiveEpochSeconds,
        decodedBytes: input.decodedBytes,
      };
      const byId = evidenceFromRow((await store.get(
        `SELECT ${EVIDENCE_COLUMNS} FROM analytics_curve_evidence WHERE evidence_id=?`,
        [evidenceId],
      )) ?? invariantMismatch());
      const byPart = evidenceFromRow((await store.get(`SELECT ${EVIDENCE_COLUMNS}
FROM analytics_curve_evidence
WHERE generation_id=? AND curve_family=? AND activity_type=?`, [
        input.generationId, input.curveFamily, input.activityType,
      ])) ?? invariantMismatch());
      if (!sameEvidence(byId, expected) || !sameEvidence(byPart, expected)) invariantMismatch();
      return Object.freeze({ evidence: byId, inserted: inserted !== undefined });
    },

    async promoteGeneration(input) {
      if (!isPlainExact(input, ["generationId", "promotedEpochSeconds"])
        || !isAddress(input.generationId) || !isEpoch(input.promotedEpochSeconds)) invalidInput();
      const generation = await readGeneration(input.generationId);
      if (input.promotedEpochSeconds < generation.frozenEpochSeconds) invalidInput();
      const evidence = await readEvidence(generation);
      if (!isCompleteEvidence(evidence)) {
        throw new Error("analytics curve generation is incomplete");
      }
      const inserted = await store.get(`INSERT INTO analytics_curve_generation_promotion (
  generation_id,promoted_epoch_s
) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING generation_id`, [
        input.generationId, input.promotedEpochSeconds,
      ]);
      const promotion = await store.get(
        "SELECT generation_id,promoted_epoch_s FROM analytics_curve_generation_promotion WHERE generation_id=?",
        [input.generationId],
      );
      if (promotion?.generation_id !== input.generationId
        || promotion.promoted_epoch_s !== input.promotedEpochSeconds) invariantMismatch();
      const before = await store.get("SELECT generation_id FROM analytics_curve_current WHERE singleton=1");
      await store.run(`INSERT INTO analytics_curve_current(singleton,generation_id) VALUES(1,?)
ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id
WHERE analytics_curve_current.generation_id != excluded.generation_id`, [input.generationId]);
      const current = await store.get("SELECT generation_id FROM analytics_curve_current WHERE singleton=1");
      if (current?.generation_id !== input.generationId) invariantMismatch();
      if (before?.generation_id === input.generationId) return "already-current";
      return inserted === undefined ? "reselected-current" : "promoted";
    },

    async recordRefreshFailure(input) {
      if (!isPlainExact(input, ["generationId", "code", "failedEpochSeconds"])
        || !isAddress(input.generationId) || !isRefreshFailureCode(input.code)
        || !isEpoch(input.failedEpochSeconds)) invalidInput();
      const generation = await readGeneration(input.generationId);
      if (input.failedEpochSeconds < generation.frozenEpochSeconds) invalidInput();
      await store.run(`INSERT INTO analytics_curve_refresh_failure (
  singleton,generation_id,code,failed_epoch_s
) VALUES(1,?,?,?)
ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id,
  code=excluded.code,failed_epoch_s=excluded.failed_epoch_s`, [
        input.generationId, input.code, input.failedEpochSeconds,
      ]);
    },

    async readState() {
      const failureRow = await store.get(
        "SELECT generation_id,code,failed_epoch_s FROM analytics_curve_refresh_failure WHERE singleton=1",
      );
      let refreshFailure: AnalyticsCurveRefreshFailure | null = null;
      if (failureRow !== undefined) {
        if (!isAddress(failureRow.generation_id) || !isRefreshFailureCode(failureRow.code)
          || !isEpoch(failureRow.failed_epoch_s)) invariantMismatch();
        const failureGeneration = await readGeneration(failureRow.generation_id);
        if (failureRow.failed_epoch_s < failureGeneration.frozenEpochSeconds) invariantMismatch();
        refreshFailure = Object.freeze({
          generationId: failureRow.generation_id,
          code: failureRow.code,
          failedEpochSeconds: failureRow.failed_epoch_s,
        });
      }
      const currentRow = await store.get(`SELECT c.generation_id,p.promoted_epoch_s
FROM analytics_curve_current AS c
JOIN analytics_curve_generation_promotion AS p ON p.generation_id=c.generation_id
WHERE c.singleton=1`);
      if (currentRow === undefined) return Object.freeze({ current: null, refreshFailure });
      if (!isAddress(currentRow.generation_id) || !isEpoch(currentRow.promoted_epoch_s)) {
        invariantMismatch();
      }
      const generation = await readGeneration(currentRow.generation_id);
      if (currentRow.promoted_epoch_s < generation.frozenEpochSeconds) invariantMismatch();
      const evidence = await readEvidence(generation);
      if (!isCompleteEvidence(evidence)) invariantMismatch();
      return Object.freeze({
        current: Object.freeze({
          generation,
          evidence: Object.freeze(evidence),
          promotedEpochSeconds: currentRow.promoted_epoch_s,
        }),
        refreshFailure,
      });
    },
  };
  return Object.freeze(repository);
}
