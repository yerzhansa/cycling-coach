// ============================================================================
// CYCLING ZONE CALCULATOR
// ============================================================================

export interface CyclingZoneDisplay {
  label: string;
  value: string;
  overlaps?: boolean;
}

/**
 * Calculate 6 cycling power zones from FTP.
 *
 * Z1 Active Recovery: < 55% FTP
 * Z2 Endurance:       56-75% FTP
 * Z3 Tempo:           76-90% FTP
 * Z4 Sweet Spot:      88-94% FTP (overlaps Z3/Z5)
 * Z5 Threshold:       95-105% FTP
 * Z6 VO2max:          106-120% FTP
 */
export function calculateCyclingZones(ftpWatts: number): CyclingZoneDisplay[] {
  return [
    { label: "Z1 Active Recovery", value: `< ${Math.round(ftpWatts * 0.55)}W` },
    {
      label: "Z2 Endurance",
      value: `${Math.round(ftpWatts * 0.56)}-${Math.round(ftpWatts * 0.75)}W`,
    },
    {
      label: "Z3 Tempo",
      value: `${Math.round(ftpWatts * 0.76)}-${Math.round(ftpWatts * 0.9)}W`,
    },
    {
      label: "Z4 Sweet Spot",
      value: `${Math.round(ftpWatts * 0.88)}-${Math.round(ftpWatts * 0.94)}W`,
      overlaps: true,
    },
    {
      label: "Z5 Threshold",
      value: `${Math.round(ftpWatts * 0.95)}-${Math.round(ftpWatts * 1.05)}W`,
    },
    {
      label: "Z6 VO2max",
      value: `${Math.round(ftpWatts * 1.06)}-${Math.round(ftpWatts * 1.2)}W`,
    },
  ];
}

export const ZONE_DESCRIPTIONS: Record<string, string> = {
  "Z1 Active Recovery": "Very light spinning for recovery",
  "Z2 Endurance": "Aerobic base building, conversational pace",
  "Z3 Tempo": "Moderate effort, sustainable for 1-2 hours",
  "Z4 Sweet Spot": "High aerobic stress, efficient training zone",
  "Z5 Threshold": "Lactate threshold, ~1 hour effort",
  "Z6 VO2max": "High intensity intervals, 3-8 minute efforts",
};

// Zone intensity midpoints as a fraction of FTP. Z7 (> 120% FTP) is
// neuromuscular/sprint; not surfaced in calculateCyclingZones but accepted
// by the intervals.icu parser and used for load estimation.
export const ZONE_INTENSITY_MIDPOINTS: Record<number, number> = {
  1: 0.45,
  2: 0.65,
  3: 0.83,
  4: 0.91,
  5: 1.0,
  6: 1.13,
  7: 1.3,
};
