export const PACE_UNAVAILABLE = "—";

export function renderPaceMMSS(speedMps: number, meters: number): string {
  if (!Number.isFinite(speedMps) || speedMps <= 0) return PACE_UNAVAILABLE;
  const totalSec = Math.round(meters / speedMps);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatPaceFromMps(speedMps: number, paceUnits?: string | null): string {
  const meters = paceUnits === "MINS_MILE" ? 1609.344 : 1000;
  const suffix = paceUnits === "MINS_MILE" ? "/mi" : "/km";
  const pace = renderPaceMMSS(speedMps, meters);
  if (pace === PACE_UNAVAILABLE) return pace;
  return `${pace}${suffix}`;
}
