/**
 * Reference layer — Python-compatible decimal rounding.
 *
 * The upstream rounds every emitted metric with Python's builtin
 * `round(x, n)`, which is round-half-to-even (banker's) applied to the
 * *true* value of the IEEE-754 double — not to a base-10 reconstruction of
 * it. Reproducing that bit-for-bit is the whole job: the parity gate asserts
 * tolerance-zero equality against snapshots Python produced, so any rounding
 * that disagrees on even one boundary flips the gate red.
 *
 * The obvious `Math.round(value * 10**n) / 10**n` is wrong, and so is every
 * decimal library seeded from a number's shortest round-trip string
 * (`new Decimal(0.005)` → "0.005"): both decide the half-distance from a
 * value that has already lost the sub-ULP information Python rounds on.
 * Concretely, `0.005` is stored as 0.005000000000000000104…, so Python
 * rounds it *up* to `0.01`; scaling by 100 yields `0.49999999999999994`,
 * which rounds *down* to `0`. ~1.3% of `secs/3600` values and ~10% of
 * one-dp percentages diverge that way.
 *
 * So we round the exact rational the double represents. A finite double is
 * `mantissa × 2^exponent` with both integers; multiply by `10^decimals`,
 * round the resulting exact fraction to the nearest integer with ties to
 * even, then divide back. All of it is done in `BigInt`, so there is no
 * intermediate float error to decide the boundary wrongly.
 */
export function roundHalfEven(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value === 0) return value;

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);

  const negative = (bits >> 63n) & 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & 0xf_ffff_ffff_ffffn;
  let exponent: number;
  if (rawExponent === 0) {
    exponent = -1074; // subnormal
  } else {
    mantissa |= 0x10_0000_0000_0000n; // restore the implicit leading 1
    exponent = rawExponent - 1075;
  }

  // |value| × 10^decimals expressed as the exact fraction numerator/denominator.
  let numerator = mantissa * 10n ** BigInt(decimals);
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubleRemainder = 2n * remainder;
  // Round half to even: round up when past the half, or exactly at the half
  // with an odd quotient.
  if (doubleRemainder > denominator || (doubleRemainder === denominator && quotient % 2n === 1n)) {
    quotient += 1n;
  }

  const magnitude = Number(quotient) / 10 ** decimals;
  return negative === 1n ? -magnitude : magnitude;
}
