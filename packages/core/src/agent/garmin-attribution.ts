import type { SourceProvenance } from "../provenance.js";

export const GARMIN_DATA_ATTRIBUTION = "Insights derived in part from Garmin device-sourced data.";

export function renderGarminAttribution(text: string, provenance: SourceProvenance): string {
  const withoutDuplicates = text
    .split("\n")
    .filter((line) => {
      const content = line.endsWith("\r") ? line.slice(0, -1) : line;
      return content.trim() !== GARMIN_DATA_ATTRIBUTION;
    })
    .join("\n");

  if (!provenance.garmin) return withoutDuplicates;
  const body = withoutDuplicates.trimEnd();
  return body.length === 0 ? withoutDuplicates : `${body}\n\n${GARMIN_DATA_ATTRIBUTION}`;
}
