import { randomBytes as systemRandomBytes } from "node:crypto";
import {
  GetUnitsPreferenceRpcResultSchema,
  SetUnitsPreferenceRpcResultSchema,
  UnitsPreferenceSchema,
  type GetUnitsPreferenceRpcResult,
  type SetUnitsPreferenceRpcResult,
  type UnitsPreference,
} from "@enduragent/coach-contract";
import type { UnitsPreferenceRepository } from "@enduragent/kernel/store";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 281_474_976_710_655;

export interface UnitsPreferenceService {
  get(): Promise<GetUnitsPreferenceRpcResult>;
  set(value: UnitsPreference): Promise<SetUnitsPreferenceRpcResult>;
}

export interface UnitsPreferenceServiceDependencies {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export function createDesktopUnitsUlid(now: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_ULID_TIME || random.length !== 10) {
    throw new TypeError("Units mutation seed is invalid.");
  }
  let value = BigInt(now);
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return encoded;
}

export function createUnitsPreferenceService(
  repository: UnitsPreferenceRepository,
  dependencies: UnitsPreferenceServiceDependencies = {},
): UnitsPreferenceService {
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? systemRandomBytes;
  return {
    async get() {
      return GetUnitsPreferenceRpcResultSchema.parse(await repository.read());
    },
    async set(value) {
      const parsed = UnitsPreferenceSchema.parse(value);
      const timestamp = now();
      const id = createDesktopUnitsUlid(timestamp, randomBytes(10));
      return SetUnitsPreferenceRpcResultSchema.parse(
        await repository.set(parsed, { id, deviceId: `desktop:${id}`, now: timestamp }),
      );
    },
  };
}
