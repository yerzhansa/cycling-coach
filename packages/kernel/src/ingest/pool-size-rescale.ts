export type PoolLengthType = "active" | "idle";

export interface PoolLengthDistanceInput {
  readonly lengthKey: string;
  readonly lengthType: PoolLengthType;
}

export interface PoolSizeRescaleInput {
  readonly sourceSessionDistanceM: number | null;
  readonly lengths: readonly PoolLengthDistanceInput[];
  readonly correctedPoolLengthM: number | null;
}

export interface PoolLengthDistanceResult {
  readonly lengthKey: string;
  readonly distanceM: number | null;
}

export interface PoolSizeRescaleResult {
  readonly sessionDistanceM: number | null;
  readonly lengths: readonly PoolLengthDistanceResult[];
}

function normalizedSource(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("source session distance must be finite and nonnegative");
  }
  return value === 0 ? 0 : value;
}

function normalizedCorrection(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("corrected pool length must be finite and positive");
  }
  return value;
}

function finiteResult(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("non-finite pool distance");
  return value === 0 ? 0 : value;
}

function validateDenseLengths(value: unknown): asserts value is readonly PoolLengthDistanceInput[] {
  if (!Array.isArray(value)) throw new TypeError("pool lengths must be an array");
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (keys.some((key) => typeof key !== "string" || !expected.has(key)) || keys.length !== expected.size) {
    throw new TypeError("pool lengths must contain only dense indexed properties");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new TypeError("pool lengths must contain enumerable data properties");
    }
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || length.value !== value.length || length.get || length.set) {
    throw new TypeError("pool lengths have an invalid length property");
  }
}

export function rescalePoolDistances(input: PoolSizeRescaleInput): PoolSizeRescaleResult {
  const sourceSessionDistanceM = normalizedSource(input.sourceSessionDistanceM);
  const correctedPoolLengthM = normalizedCorrection(input.correctedPoolLengthM);
  validateDenseLengths(input.lengths);
  const lengths = input.lengths.map((length) => {
    if (typeof length.lengthKey !== "string" || length.lengthKey.length === 0) {
      throw new TypeError("length key must not be empty");
    }
    if (length.lengthType !== "active" && length.lengthType !== "idle") {
      throw new TypeError("unknown pool length type");
    }
    return { lengthKey: length.lengthKey, lengthType: length.lengthType };
  });
  const activeCount = lengths.filter((length) => length.lengthType === "active").length;
  const derivable = sourceSessionDistanceM !== null && sourceSessionDistanceM > 0 && activeCount > 0;
  if (!derivable) {
    if (correctedPoolLengthM !== null) throw new RangeError("pool correction requires original pool length");
    return {
      sessionDistanceM: sourceSessionDistanceM,
      lengths: lengths.map((length) => ({ lengthKey: length.lengthKey, distanceM: null })),
    };
  }
  const originalPoolLengthM = finiteResult(sourceSessionDistanceM / activeCount);
  if (originalPoolLengthM <= 0) throw new RangeError("pool length must be positive");
  if (correctedPoolLengthM === null) {
    return {
      sessionDistanceM: sourceSessionDistanceM,
      lengths: lengths.map((length) => ({
        lengthKey: length.lengthKey,
        distanceM: length.lengthType === "active" ? originalPoolLengthM : 0,
      })),
    };
  }
  const multiplier = finiteResult(correctedPoolLengthM / originalPoolLengthM);
  return {
    sessionDistanceM: finiteResult(sourceSessionDistanceM * multiplier),
    lengths: lengths.map((length) => ({
      lengthKey: length.lengthKey,
      distanceM: length.lengthType === "active" ? finiteResult(originalPoolLengthM * multiplier) : 0,
    })),
  };
}
