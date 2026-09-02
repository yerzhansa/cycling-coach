const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MILLISECONDS_PER_DAY = 86_400_000;

function civilDateFromEpochMilliseconds(value: number): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9_999) {
    throw new TypeError("invalid civil date");
  }
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function civilEpochMilliseconds(value: string): number {
  if (!CIVIL_DATE_PATTERN.test(value)) throw new TypeError("invalid civil date");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (civilDateFromEpochMilliseconds(date.getTime()) !== value) {
    throw new TypeError("invalid civil date");
  }
  return date.getTime();
}

export function addCivilDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new TypeError("invalid civil day offset");
  return civilDateFromEpochMilliseconds(
    civilEpochMilliseconds(value) + days * MILLISECONDS_PER_DAY,
  );
}

export function mondayOfWeek(value: string): string {
  const epoch = civilEpochMilliseconds(value);
  const weekday = new Date(epoch).getUTCDay();
  return addCivilDays(value, -((weekday + 6) % 7));
}
