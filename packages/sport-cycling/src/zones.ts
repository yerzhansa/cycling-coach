// ============================================================================
// CYCLING ZONE CALCULATOR
// ============================================================================

export interface CyclingZoneDisplay {
  label: string;
  value: string;
  overlaps?: boolean;
}

/**
 * Calculate cycling power-zone watt ranges from FTP, mainstream 7-zone numbering.
 *
 * Z1 Active Recovery: < 55% FTP
 * Z2 Endurance:       56-75% FTP
 * Z3 Tempo:           76-90% FTP
 * Z4 Threshold:       91-105% FTP (FTP lives here)
 * Z5 VO2max:          106-120% FTP
 *
 * Sweet Spot is the 88-94% FTP named sub-range (top of Z3 into low Z4), NOT a
 * numbered zone; surfaced here as a "Sweet Spot (88-94%)" row by name, accessed
 * by percent rather than a bare zone integer. Anaerobic (Z6, 121-150%) and
 * Neuromuscular (Z7, > 150%) are above this display helper's range.
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
      label: "Sweet Spot (88-94%)",
      value: `${Math.round(ftpWatts * 0.88)}-${Math.round(ftpWatts * 0.94)}W`,
      overlaps: true,
    },
    {
      label: "Z4 Threshold",
      value: `${Math.round(ftpWatts * 0.91)}-${Math.round(ftpWatts * 1.05)}W`,
    },
    {
      label: "Z5 VO2max",
      value: `${Math.round(ftpWatts * 1.06)}-${Math.round(ftpWatts * 1.2)}W`,
    },
  ];
}

export const ZONE_DESCRIPTIONS: Record<string, string> = {
  "Z1 Active Recovery": "Very light spinning for recovery",
  "Z2 Endurance": "Aerobic base building, conversational pace",
  "Z3 Tempo": "Moderate effort, sustainable for 1-2 hours",
  "Sweet Spot (88-94%)": "High aerobic stress, efficient training sub-range",
  "Z4 Threshold": "Lactate threshold, ~1 hour effort",
  "Z5 VO2max": "High intensity intervals, 3-8 minute efforts",
};

// Zone intensity midpoints as a fraction of FTP, keyed to the mainstream 7-zone
// Coggan model intervals.icu resolves serialized targets against (Z4 Threshold,
// Z5 VO2max, Z6 Anaerobic, Z7 Neuromuscular). Each index is the band-center of
// the athlete's Z<n> band, so the calendar Load estimate for a `kind: "zone"`
// target agrees with the band a rendered `Z<n>` step actually demands. Sweet
// spot (88-94% FTP) is a named sub-range, accessed by percent, not a zone index.
export const ZONE_INTENSITY_MIDPOINTS: Record<number, number> = {
  1: 0.45,
  2: 0.65,
  3: 0.83,
  4: 0.98,
  5: 1.13,
  6: 1.355,
  7: 1.6,
};
