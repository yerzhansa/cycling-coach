type Fraction = { readonly numerator: bigint; readonly denominator: bigint };

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function normalize(value: Fraction): Fraction {
  if (value.numerator === 0n) return { numerator: 0n, denominator: 1n };
  const sign = value.denominator < 0n ? -1n : 1n;
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function add(left: Fraction, right: Fraction): Fraction {
  const divisor = greatestCommonDivisor(left.denominator, right.denominator);
  const leftScale = right.denominator / divisor;
  const rightScale = left.denominator / divisor;
  return normalize({
    numerator: left.numerator * leftScale + right.numerator * rightScale,
    denominator: left.denominator * leftScale,
  });
}

function subtract(left: Fraction, right: Fraction): Fraction {
  return add(left, { numerator: -right.numerator, denominator: right.denominator });
}

function multiply(left: Fraction, right: Fraction): Fraction {
  const a = greatestCommonDivisor(left.numerator, right.denominator);
  const b = greatestCommonDivisor(right.numerator, left.denominator);
  return normalize({
    numerator: (left.numerator / a) * (right.numerator / b),
    denominator: (left.denominator / b) * (right.denominator / a),
  });
}

function divide(left: Fraction, right: Fraction): Fraction {
  return multiply(left, { numerator: right.denominator, denominator: right.numerator });
}

function fractionFromDouble(value: number): Fraction {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n === 0n ? 1n : -1n;
  const storedExponent = Number((bits >> 52n) & 0x7ffn);
  let significand = bits & 0xf_ffff_ffff_ffffn;
  let binaryExponent: number;
  if (storedExponent === 0) {
    binaryExponent = -1074;
  } else {
    significand += 0x10_0000_0000_0000n;
    binaryExponent = storedExponent - 1075;
  }
  const signed = sign * significand;
  return binaryExponent >= 0
    ? { numerator: signed << BigInt(binaryExponent), denominator: 1n }
    : normalize({ numerator: signed, denominator: 1n << BigInt(-binaryExponent) });
}

function pairwise(values: readonly Fraction[]): Fraction {
  if (values.length === 0) return { numerator: 0n, denominator: 1n };
  let layer = [...values];
  while (layer.length > 1) {
    const next: Fraction[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      next.push(index + 1 < layer.length ? add(layer[index]!, layer[index + 1]!) : layer[index]!);
    }
    layer = next;
  }
  return layer[0]!;
}

function width(value: bigint): number {
  return value.toString(2).length;
}

function nearestDouble(value: Fraction): number {
  if (value.numerator === 0n) return 0;
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const denominator = value.denominator;
  let shift = 54 - (width(numerator) - width(denominator));
  let quotient =
    shift >= 0
      ? (numerator << BigInt(shift)) / denominator
      : numerator / (denominator << BigInt(-shift));
  let remainder =
    shift >= 0
      ? (numerator << BigInt(shift)) % denominator
      : numerator % (denominator << BigInt(-shift));
  while (width(quotient) > 54) {
    if ((quotient & 1n) !== 0n) remainder = 1n;
    quotient >>= 1n;
    shift -= 1;
  }
  const halfway = quotient & 1n;
  let significand = quotient >> 1n;
  let exponent = shift - 1;
  if (halfway !== 0n && (remainder !== 0n || (significand & 1n) !== 0n)) significand += 1n;
  if (significand === 1n << 53n) {
    significand >>= 1n;
    exponent -= 1;
  }
  const result = Number(significand) * 2 ** -exponent;
  return negative ? -result : result;
}

function integerRoot(value: bigint): bigint {
  if (value < 2n) return value;
  let upper = value;
  let lower = (upper + 1n) >> 1n;
  while (lower < upper) {
    upper = lower;
    lower = (upper + value / upper) >> 1n;
  }
  return upper;
}

function oddRoot(numerator: bigint, denominator: bigint): bigint {
  const root = integerRoot(numerator / denominator);
  return root * root * denominator === numerator ? root : root | 1n;
}

function nearestRoot(value: Fraction): number {
  if (value.numerator === 0n) return 0;
  const targetWidth = 109;
  const scale = Math.floor((width(value.numerator) - width(value.denominator) - targetWidth) / 2);
  if (scale >= 0) {
    const result = oddRoot(value.numerator, value.denominator << BigInt(2 * scale));
    return Number(result << BigInt(scale));
  }
  const result = oddRoot(value.numerator << BigInt(-2 * scale), value.denominator);
  return Number(result) / Number(1n << BigInt(-scale));
}

function independentCompensatedSum(values: number[]): number {
  let primary = 0;
  let correction = 0;
  for (const value of values) {
    const next = primary + value;
    correction +=
      Math.abs(primary) < Math.abs(value) ? value - next + primary : primary - next + value;
    primary = next;
  }
  return primary + correction;
}

function independentMean(values: number[]): number {
  const total = pairwise(values.map(fractionFromDouble));
  if (values.length === 0) return 0;
  return nearestDouble(divide(total, { numerator: BigInt(values.length), denominator: 1n }));
}

function independentSampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const fractions = values.map(fractionFromDouble);
  const count = { numerator: BigInt(values.length), denominator: 1n };
  const average = divide(pairwise(fractions), count);
  const squaredDifferences = fractions.map((value) => {
    const difference = subtract(value, average);
    return multiply(difference, difference);
  });
  const variance = divide(pairwise(squaredDifferences), {
    numerator: BigInt(values.length - 1),
    denominator: 1n,
  });
  return nearestRoot(variance);
}

export const DIFFERENTIAL_OPERATIONS = {
  pythonSum: independentCompensatedSum,
  mean: independentMean,
  sampleStdev: independentSampleStdev,
} as const;
