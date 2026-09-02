export function utcCivilDateFromEpochSeconds(value: number): string {
  const date = new Date(value * 1_000);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9_999) {
    throw new TypeError("invalid epoch seconds");
  }
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
