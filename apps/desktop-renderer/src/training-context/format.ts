import type { UnitsPreference } from "@enduragent/coach-contract";

const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

export function formatUtcTimestamp(value: string): string {
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (match === null) return "Unknown sync time";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "Unknown sync time";
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return "Unknown sync time";
  const offsetSign = match[8] === "-" ? -1 : 1;
  const local = new Date(milliseconds + offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000);
  if (
    local.getUTCFullYear() !== Number(match[1]) ||
    local.getUTCMonth() + 1 !== Number(match[2]) ||
    local.getUTCDate() !== Number(match[3]) ||
    local.getUTCHours() !== Number(match[4]) ||
    local.getUTCMinutes() !== Number(match[5]) ||
    local.getUTCSeconds() !== Number(match[6])
  ) {
    return "Unknown sync time";
  }
  const normalized = new Date(milliseconds).toISOString();
  return `${normalized.slice(0, 10)} ${normalized.slice(11, 19)} UTC`;
}

export function formatWholeNumber(value: number): string {
  return Math.round(value).toString();
}

export function formatPercentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatSleepDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatRidingDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

export function formatDistance(value: number, units: UnitsPreference): string {
  const converted = units === "imperial" ? value / 1_609.344 : value / 1_000;
  const rounded = Math.round(converted * 10) / 10;
  return `${rounded.toFixed(Number.isInteger(rounded) ? 0 : 1)} ${
    units === "imperial" ? "mi" : "km"
  }`;
}
