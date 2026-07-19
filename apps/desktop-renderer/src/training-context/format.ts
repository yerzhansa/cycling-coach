export function formatDateLabel(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value);
  if (match === null) return "Unknown date";
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : "Unknown date";
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
