export const GARMIN_DATA_ATTRIBUTION =
  "Insights derived in part from Garmin device-sourced data.";

export function appendGarminAttribution(text: string): string {
  const withoutDuplicates = text
    .trimEnd()
    .split("\n")
    .filter((line) => {
      const content = line.endsWith("\r") ? line.slice(0, -1) : line;
      return content !== GARMIN_DATA_ATTRIBUTION;
    })
    .join("\n")
    .trimEnd();

  return withoutDuplicates.length === 0
    ? GARMIN_DATA_ATTRIBUTION
    : `${withoutDuplicates}\n\n${GARMIN_DATA_ATTRIBUTION}`;
}
