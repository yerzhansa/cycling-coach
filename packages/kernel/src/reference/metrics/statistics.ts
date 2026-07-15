/**
 * Reference layer — Python-compatible exact statistics.
 *
 * The upstream computes total/primary-sport monotony and the wellness
 * baselines with Python's `statistics.mean` / `statistics.stdev`, which
 * accumulate in exact rational arithmetic (`Fraction`) and round to a
 * double only at the very end. A naive float `sum/n` and a float two-pass
 * stdev diverge from that in the last ULPs, and the divergence can survive
 * the final `round(_, 2)` at a boundary — e.g. daily loads
 * `[21.2, 154.3, 268.1, 122.0, 34.6, 33.1, 231.2]` give float monotony
 * `1.23` where Python gives `1.24`. The parity gate is tolerance-zero, so
 * we reproduce the exact-rational path in `BigInt`.
 *
 * Target semantics are the snapshot oracle, which runs the upstream under
 * Pyodide (CPython 3.13):
 *
 *   mean(data)  = float(Σxᵢ / n)                  — nearest double
 *   stdev(data) = correctly-rounded √(Σ(xᵢ − mean)² / (n − 1))
 *
 * `mean` is version-stable. `stdev` is NOT: CPython ≤3.11 returned
 * `math.sqrt(float(variance))` (two rounding steps), but 3.12+ rounds the
 * square root of the *exact* variance fraction once, via
 * `_float_sqrt_of_frac` (round-to-odd integer sqrt, then a single
 * round-to-nearest-even). The two disagree by a ULP often enough
 * (~13% of vectors) that mirroring the wrong one is itself a deviation, so
 * we reproduce the 3.12+ correctly-rounded path. `stdev` derives its own
 * exact mean internally, independent of the value `mean()` returns.
 *
 * Each finite double is the exact dyadic rational `num / 2^k` (`num`
 * signed, `k ≥ 0`); sums of such rationals stay exact in `BigInt`, so the
 * only rounding is the single correctly-rounded `ratioToDouble` at the end
 * — mirroring `float(Fraction)`.
 *
 * Out of scope here, by policy: transcendentals (`log`/`exp`/`pow`/trig).
 * IEEE-754 does not mandate correctly-rounded transcendentals, so V8's `Math.*`
 * and the oracle's libm (Pyodide/emscripten) may disagree in the last ULP. We
 * do NOT reproduce the oracle's libm for these — V8's `Math.*` is used directly
 * and the last-ULP agreement is accepted as a platform fidelity residual. The
 * first instance is `polarization_index`'s `log10` (see `distribution.ts`):
 * ~1e-14 reachability, and the tolerance-zero gate would surface a
 * boundary-straddle in CI rather than ship it. Future transcendental metrics
 * inherit this acceptance unless a real fixture trips the gate — at which point
 * the choice is regenerate-the-snapshot or reproduce-the-exact-libm for that op.
 */

function bitLength(value: bigint): number {
  return value.toString(2).length;
}

// Python `sum(values)` on CPython 3.12+ — which switched the builtin from
// naive left-to-right accumulation to Neumaier compensated summation for
// floats (bpo-43475). The two disagree by a ULP often enough to flip a
// downstream `round()` boundary: e.g. summing the daily-load array
// [0, 0, 9.7, 266.4, 239.5, 9.4, 0] gives 525.0 here but 524.999…9 naively,
// which moves `round(tss × 0.62, 0)` from 326 to 325. Mirror the oracle.
export function pythonSum(values: number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const x of values) {
    const t = sum + x;
    compensation += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return sum + compensation;
}

// A finite double as the exact rational `num / 2^k` (k ≥ 0, num signed).
function toRatio(value: number): { num: bigint; k: bigint } {
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

  let num: bigint;
  let k: bigint;
  if (exponent >= 0) {
    num = mantissa << BigInt(exponent);
    k = 0n;
  } else {
    num = mantissa;
    k = BigInt(-exponent);
  }
  return { num: negative === 1n ? -num : num, k };
}

// Correctly-rounded (ties to even) double nearest to `numerator / denominator`,
// matching Python's `float(Fraction(numerator, denominator))`. `denominator`
// must be a positive integer.
function ratioToDouble(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 0;
  const negative = numerator < 0n;
  const num = negative ? -numerator : numerator;
  const den = denominator;

  // Scale so the integer quotient lands in [2^53, 2^55): 54 or 55 bits, a
  // 53-bit significand plus at least one round bit. `bitLength` brackets
  // log2 to ±1, so `54 - approx` guarantees ≥ 54 bits — only ever too wide.
  const approx = bitLength(num) - bitLength(den);
  let shift = 54 - approx;
  const scaledNum = shift >= 0 ? num << BigInt(shift) : num;
  const scaledDen = shift >= 0 ? den : den << BigInt(-shift);

  let quotient = scaledNum / scaledDen;
  let remainder = scaledNum % scaledDen;

  // Shed surplus low bits down to exactly 54, folding any dropped 1 into the
  // sticky remainder so the round decision still sees it.
  let bits = bitLength(quotient);
  while (bits > 54) {
    if ((quotient & 1n) === 1n) remainder = 1n;
    quotient >>= 1n;
    shift -= 1;
    bits -= 1;
  }

  // quotient ∈ [2^53, 2^54): one round bit below the 53-bit significand.
  const roundBit = quotient & 1n;
  let mantissa = quotient >> 1n;
  let exponent = shift - 1; // value ≈ mantissa · 2^(−exponent)
  if (roundBit === 1n) {
    if (remainder !== 0n) {
      mantissa += 1n; // strictly past the half → up
    } else if ((mantissa & 1n) === 1n) {
      mantissa += 1n; // exact half → ties to even
    }
  }
  if (mantissa === 1n << 53n) {
    mantissa >>= 1n; // rounding carried out of 53 bits
    exponent -= 1;
  }

  const magnitude = Number(mantissa) * 2 ** -exponent;
  return negative ? -magnitude : magnitude;
}

// Σ of the values' exact rationals over the common denominator 2^maxK, as an
// integer numerator plus that shared maxK. Shared by `mean` and `sampleStdev`.
function exactSums(values: number[]): {
  sx: bigint; // Σ xᵢ · 2^maxK   (i.e. Σxᵢ over denominator 2^maxK)
  sxx: bigint; // Σ xᵢ² · 2^(2·maxK)  (Σxᵢ² over denominator 2^(2·maxK))
  maxK: bigint;
} {
  const ratios = values.map(toRatio);
  let maxK = 0n;
  for (const r of ratios) if (r.k > maxK) maxK = r.k;

  let sx = 0n;
  let sxx = 0n;
  for (const r of ratios) {
    sx += r.num << (maxK - r.k);
    sxx += (r.num * r.num) << (2n * maxK - 2n * r.k);
  }
  return { sx, sxx, maxK };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function bigIntSqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + value / x) >> 1n;
  }
  return x;
}

// Python `statistics._integer_sqrt_of_frac_rto` — √(n/m) to the nearest
// integer using round-to-odd (sets the low bit when n/m is not a perfect
// square, so the subsequent round-to-nearest-even can't double-round).
function integerSqrtOfFracRto(n: bigint, m: bigint): bigint {
  const a = bigIntSqrt(n / m);
  return a * a * m !== n ? a | 1n : a;
}

const SQRT_BIT_WIDTH = 2 * 53 + 3; // 2 · mantissa-digits + 3

// Python `statistics._float_sqrt_of_frac` — correctly-rounded √(n/m).
// SQRT_BIT_WIDTH scales the round-to-odd integer sqrt so `numerator` carries
// ~mant_dig+2 (≈55) significant bits — NOT ≤53 — with its low bit set as a
// sticky round bit (round-to-odd) so that narrowing it to a 53-bit double is
// correctly rounded. `denominator` (and the `<< q` factor) are powers of two,
// so `Number(numerator) / Number(denominator)` only shifts the binary exponent
// — no second rounding. The lone rounding is `Number(numerator)`, which
// round-to-odd makes exact. A non-power-of-two denominator would round a second
// time and defeat round-to-odd, diverging from CPython's Fraction-exact sqrt.
function floatSqrtOfFrac(n: bigint, m: bigint): number {
  if (n === 0n) return 0;
  const q = Math.floor((bitLength(n) - bitLength(m) - SQRT_BIT_WIDTH) / 2);
  let numerator: bigint;
  let denominator: bigint;
  if (q >= 0) {
    numerator = integerSqrtOfFracRto(n, m << BigInt(2 * q)) << BigInt(q);
    denominator = 1n;
  } else {
    numerator = integerSqrtOfFracRto(n << BigInt(-2 * q), m);
    denominator = 1n << BigInt(-q);
  }
  return Number(numerator) / Number(denominator);
}

// Python `statistics.mean(values)` — float(Σxᵢ / n). `mean([])` returns 0
// (ratioToDouble short-circuits on a zero numerator), not NaN and not the
// StatisticsError Python raises; every caller guards a non-empty input.
export function mean(values: number[]): number {
  const n = BigInt(values.length);
  const { sx, maxK } = exactSums(values);
  return ratioToDouble(sx, n << maxK);
}

// Python `statistics.stdev(values)` on CPython 3.12+ — the correctly-rounded
// square root of the exact variance (exact sum of squared deviations over
// n − 1). The variance fraction is reduced first, matching the `Fraction`
// `mss.numerator/mss.denominator` the upstream passes in. Requires n ≥ 2;
// below that it returns 0 (varianceNum is 0n, so floatSqrtOfFrac short-circuits
// before the n−1 = 0 denominator divides — no throw), not the NaN the
// pre-rewrite float impl produced. 0 is guard-friendly: callers gate on
// `stdev <= 0`, which 0 satisfies but NaN would have slipped through.
export function sampleStdev(values: number[]): number {
  const n = BigInt(values.length);
  const { sx, sxx, maxK } = exactSums(values);

  // ss = Σ(xᵢ − mean)² = Σxᵢ² − (Σxᵢ)²/n, exact:
  //   ss = (sxx·n − sx²) / (2^(2·maxK) · n)
  //   variance = ss / (n − 1) = (sxx·n − sx²) / (2^(2·maxK) · n · (n − 1))
  let varianceNum = sxx * n - sx * sx;
  let varianceDen = (1n << (2n * maxK)) * n * (n - 1n);
  const g = gcd(varianceNum, varianceDen);
  if (g > 1n) {
    varianceNum /= g;
    varianceDen /= g;
  }
  return floatSqrtOfFrac(varianceNum, varianceDen);
}
