export type RepairValue = number | null;

export interface CanonicalRepairStream {
  readonly time: readonly number[];
  readonly channels: Readonly<Record<string, readonly RepairValue[]>>;
}

export interface ChannelChanges {
  readonly channel: string;
  readonly changedIndices: readonly number[];
}

export interface RepairStageResult {
  readonly stream: CanonicalRepairStream;
  readonly changes: readonly ChannelChanges[];
}

export type RepairFixer = "chronoBridge" | "summitGuard" | "pulseWeave";

export const REPAIR_FIXERS = Object.freeze([
  "chronoBridge",
  "summitGuard",
  "pulseWeave",
] as const);

export interface RepairFixerSettings {
  readonly chronoBridge: boolean;
  readonly summitGuard: boolean;
  readonly pulseWeave: boolean;
}

export const DEFAULT_REPAIR_FIXER_SETTINGS: RepairFixerSettings = Object.freeze({
  chronoBridge: false,
  summitGuard: false,
  pulseWeave: false,
});

export const ALL_REPAIR_FIXERS_ENABLED: RepairFixerSettings = Object.freeze({
  chronoBridge: true,
  summitGuard: true,
  pulseWeave: true,
});

export function normalizeRepairFixerSettings(value: unknown): RepairFixerSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid repair fixer settings");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("invalid repair fixer settings");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== REPAIR_FIXERS.length || ownKeys.some((key) => typeof key !== "string")
    || REPAIR_FIXERS.some((fixer) => !Object.prototype.hasOwnProperty.call(value, fixer))) {
    throw new TypeError("invalid repair fixer settings");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const settings: Record<RepairFixer, boolean> = {
    chronoBridge: false,
    summitGuard: false,
    pulseWeave: false,
  };
  for (const fixer of REPAIR_FIXERS) {
    const descriptor = descriptors[fixer];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "boolean") {
      throw new TypeError("invalid repair fixer settings");
    }
    settings[fixer] = descriptor.value;
  }
  return Object.freeze({
    chronoBridge: settings.chronoBridge,
    summitGuard: settings.summitGuard,
    pulseWeave: settings.pulseWeave,
  });
}

export interface RepairInvocationLog {
  readonly fixer: RepairFixer;
  readonly params: Readonly<Record<string, unknown>>;
  readonly changes: readonly ChannelChanges[];
}

export interface RepairChainResult {
  readonly stream: CanonicalRepairStream;
  readonly logs: readonly RepairInvocationLog[];
}

function unicodeScalars(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const first = input.charCodeAt(i);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (i + 1 >= input.length) throw new TypeError("unpaired Unicode surrogate");
      const second = input.charCodeAt(i + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        throw new TypeError("unpaired Unicode surrogate");
      }
      out.push(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
      i += 1;
    } else {
      if (first >= 0xdc00 && first <= 0xdfff) {
        throw new TypeError("unpaired Unicode surrogate");
      }
      out.push(first);
    }
  }
  return out;
}

export function compareUnicodeCodePoints(left: string, right: string): number {
  const a = unicodeScalars(left);
  const b = unicodeScalars(right);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function interpolateFinite(left: number, right: number, ratio: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new TypeError("finite endpoints required");
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError("ratio must be in [0,1]");
  let value: number;
  if (left === right) value = left;
  else if ((left < 0 && right > 0) || (left > 0 && right < 0)) {
    value = left * (1 - ratio) + right * ratio;
  } else {
    value = left + (right - left) * ratio;
  }
  if (!Number.isFinite(value)) throw new RangeError("non-finite interpolation result");
  return value === 0 ? 0 : value;
}

export function averageFinite(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new TypeError("finite operands required");
  const value = left / 2 + right / 2;
  if (!Number.isFinite(value)) throw new RangeError("non-finite average result");
  return value === 0 ? 0 : value;
}

export function finiteAbsDifference(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new TypeError("finite operands required");
  const value = Math.abs(left - right);
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

export function finiteScaledMad(mad: number): number {
  if (!Number.isFinite(mad) || mad < 0) throw new TypeError("finite nonnegative MAD required");
  const value = 3 * 1.4826 * mad;
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

function assertDenseArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError(`${name} must be dense`);
  }
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value === 0 ? 0 : value;
}

export function cloneValidatedRepairStream(input: CanonicalRepairStream): CanonicalRepairStream {
  if (input === null || typeof input !== "object") throw new TypeError("repair stream must be an object");
  assertDenseArray(input.time, "time");
  if (input.time.length < 1) throw new TypeError("time must not be empty");
  const time = input.time.map((value, index) => finiteNumber(value, `time[${index}]`));
  for (let index = 1; index < time.length; index += 1) {
    if (time[index]! <= time[index - 1]!) throw new TypeError("timestamps must be strictly increasing");
  }
  if (input.channels === null || typeof input.channels !== "object" || Array.isArray(input.channels)) {
    throw new TypeError("channels must be an object");
  }
  const channels = Object.create(null) as Record<string, RepairValue[]>;
  for (const channel of Object.keys(input.channels).sort(compareUnicodeCodePoints)) {
    if (channel.length === 0) throw new TypeError("channel name must not be empty");
    unicodeScalars(channel);
    const source = input.channels[channel];
    assertDenseArray(source, `channel ${channel}`);
    if (source.length !== time.length) throw new TypeError("channel length mismatch");
    channels[channel] = source.map((value, index) =>
      value === null ? null : finiteNumber(value, `${channel}[${index}]`),
    );
  }
  return { time, channels };
}

export function changedIndices(before: readonly RepairValue[], after: readonly RepairValue[]): number[] {
  if (before.length !== after.length) throw new TypeError("change arrays must align");
  const result: number[] = [];
  for (let index = 0; index < before.length; index += 1) {
    if (!Object.is(before[index], after[index])) result.push(index);
  }
  return result;
}
