import type { CryptoPort } from "../ports/crypto.js";
import { compareUnicodeCodePoints, type RepairFixer } from "../ingest/repair/types.js";
import { sortKeys } from "./canonical-json.js";
import { H } from "./derived-key.js";
import type { RepairLogInsert, RepairLogRepository, RepairLogRow, Row, SqlStore } from "./ports.js";

const FIXERS = new Set<RepairFixer>(["chronoBridge", "summitGuard", "pulseWeave"]);
const expectedParamsJson: Readonly<Record<RepairFixer, string>> = {
  chronoBridge: '{"boundaryPolicy":"bounded-only","interpolation":"linear","maxMissingSeconds":5}',
  summitGuard: '{"convergence":"fixed-point","madScale":1.4826,"powerFloorWatts":50,"speedFloorMps":2,"thresholdScaledMad":3,"windowSamples":7}',
  pulseWeave: '{"boundaryPolicy":"bounded-only","convergence":"fixed-point","flatlineBoundaryDeltaBpm":5,"flatlineMinSeconds":10,"interpolation":"linear","maxRepairSeconds":30,"plausibleBpm":[35,230],"zeroOrImplausibleMaxBpm":30,"zeroRunMinSeconds":2}',
};

export class RepairLogInvariantError extends Error {
  constructor() {
    super("repair log invariant mismatch");
    this.name = "RepairLogInvariantError";
  }
}

function denseIndices(value: unknown): number[] {
  if (!Array.isArray(value)) throw new TypeError("changed indices must be an array");
  assertArrayShape(value, "changed indices");
  const result: number[] = [];
  let previous = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("changed indices must be dense");
    const member = value[index];
    if (!Number.isSafeInteger(member) || (member as number) < 0 || (member as number) <= previous) {
      throw new TypeError("changed indices must be strictly ascending nonnegative safe integers");
    }
    previous = member as number;
    result.push(previous);
  }
  return result;
}

function assertDataProperty(object: object, key: PropertyKey, name: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
    throw new TypeError(`${name} must contain enumerable data properties`);
  }
  return descriptor;
}

function assertArrayShape(value: unknown[], name: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) throw new TypeError(`${name} must not contain symbols`);
  const expected = new Set<string>(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (keys.some((key) => typeof key !== "string" || !expected.has(key)) || keys.length !== expected.size) {
    throw new TypeError(`${name} must contain only dense indexed properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    assertDataProperty(value, String(index), name);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || length.value !== value.length || length.get || length.set) {
    throw new TypeError(`${name} has an invalid length property`);
  }
}

function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("repair params must be finite");
    return;
  }
  if (typeof value !== "object") throw new TypeError("repair params contain unsupported value");
  if (ancestors.has(value)) throw new TypeError("repair params must not be cyclic");
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    assertArrayShape(value, "repair params arrays");
  } else if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("repair params must contain plain objects");
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError("repair params must not contain symbols");
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (key === "__proto__") throw new TypeError("repair params contain an unsupported property name");
      const descriptor = assertDataProperty(value, key, "repair params");
      validateJson(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function exactRow(row: Row, expected: RepairLogRow): boolean {
  return row.repair_key === expected.repair_key
    && row.raw_sha256 === expected.raw_sha256
    && row.session_key === expected.session_key
    && row.channel === expected.channel
    && row.fixer === expected.fixer
    && row.changed_count === expected.changed_count
    && row.changed_indices_json === expected.changed_indices_json
    && row.params_json === expected.params_json;
}

export function createRepairLogRepository(store: SqlStore, crypto: CryptoPort): RepairLogRepository {
  return {
    async insertOrAssertIdentical(input: RepairLogInsert): Promise<void> {
      const rawSha256 = string(input.rawSha256, "raw SHA");
      if (!/^[0-9a-f]{64}$/.test(rawSha256)) throw new TypeError("raw SHA must be lowercase hex");
      const sessionKey = string(input.sessionKey, "session key");
      const channel = string(input.channel, "channel");
      compareUnicodeCodePoints(channel, channel);
      const fixer = input.fixer;
      if (!FIXERS.has(fixer)) throw new TypeError("unknown repair fixer");
      const changedIndices = denseIndices(input.changedIndices);
      if (input.params === null || typeof input.params !== "object" || Array.isArray(input.params)) {
        throw new TypeError("repair params must be a plain object");
      }
      const proto = Object.getPrototypeOf(input.params);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("repair params must be a plain object");
      validateJson(input.params);
      const changedIndicesJson = JSON.stringify(changedIndices);
      const paramsJson = JSON.stringify(sortKeys(input.params));
      if (paramsJson !== expectedParamsJson[fixer]) throw new TypeError("repair params do not match fixer");
      const repairKey = await H(crypto, "repair_log", rawSha256, sessionKey, channel, fixer);
      const expected: RepairLogRow = {
        repair_key: repairKey,
        raw_sha256: rawSha256,
        session_key: sessionKey,
        channel,
        fixer,
        changed_count: changedIndices.length,
        changed_indices_json: changedIndicesJson,
        params_json: paramsJson,
      };
      await store.run(
        `INSERT INTO repair_log
  (repair_key, raw_sha256, session_key, channel, fixer, changed_count, changed_indices_json, params_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING`,
        [repairKey, rawSha256, sessionKey, channel, fixer, changedIndices.length, changedIndicesJson, paramsJson],
      );
      const selected = await store.get(
        `SELECT repair_key, raw_sha256, session_key, channel, fixer,
       changed_count, changed_indices_json, params_json
FROM repair_log
WHERE raw_sha256 = ? AND session_key = ? AND channel = ? AND fixer = ?`,
        [rawSha256, sessionKey, channel, fixer],
      );
      if (selected === undefined || !exactRow(selected, expected)) throw new RepairLogInvariantError();
      const selectedFixer = selected.fixer;
      if (typeof selectedFixer !== "string" || !FIXERS.has(selectedFixer as RepairFixer)) throw new RepairLogInvariantError();
      const recomputed = await H(crypto, "repair_log", String(selected.raw_sha256), String(selected.session_key), String(selected.channel), selectedFixer);
      if (recomputed !== selected.repair_key) throw new RepairLogInvariantError();
    },
  };
}
