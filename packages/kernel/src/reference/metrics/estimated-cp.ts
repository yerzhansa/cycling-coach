export interface CriticalPowerPoint {
  readonly durationS: number;
  readonly averagePowerW: number;
}

export type CriticalPowerEstimate =
  | {
      readonly status: "available";
      readonly cpWatts: number;
      readonly wPrimeJ: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "mathematically-invalid";
    };

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Enduragent's display-only two-point CP calculation boundary.
 *
 * The caller owns evidence eligibility and duration-band selection. This
 * function owns only the exact two-parameter equations and mathematical
 * validity checks documented in docs/formulas/critical-power-two-parameter-model.md.
 */
export function estimateCriticalPower(input: {
  readonly short: CriticalPowerPoint;
  readonly long: CriticalPowerPoint;
}): CriticalPowerEstimate {
  const shortDuration = input.short.durationS;
  const shortPower = input.short.averagePowerW;
  const longDuration = input.long.durationS;
  const longPower = input.long.averagePowerW;
  if (
    !finitePositive(shortDuration) ||
    !finitePositive(shortPower) ||
    !finitePositive(longDuration) ||
    !finitePositive(longPower) ||
    longDuration <= shortDuration ||
    shortPower <= longPower ||
    longPower * longDuration <= shortPower * shortDuration
  ) {
    return { status: "unavailable", reason: "mathematically-invalid" };
  }
  const denominator = longDuration - shortDuration;
  const cpWatts = (longPower * longDuration - shortPower * shortDuration) / denominator;
  const wPrimeJ = ((shortPower - longPower) * shortDuration * longDuration) / denominator;
  if (!finitePositive(cpWatts) || !finitePositive(wPrimeJ)) {
    return { status: "unavailable", reason: "mathematically-invalid" };
  }
  return { status: "available", cpWatts, wPrimeJ };
}
