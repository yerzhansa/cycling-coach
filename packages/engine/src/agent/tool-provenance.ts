import { isUntrustedEnvelope } from "./prompt-fence.js";
import {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  isNonEmptyData,
  provenanceForSourceBearingData,
  type SourceProvenance,
} from "../provenance.js";
import { boundToolResultProvenance } from "../sport/bound-tool-result.js";

function payloadOf(result: unknown): unknown {
  return isUntrustedEnvelope(result) ? result.data : result;
}

function isErrorOrCap(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return "error" in record || record.truncated === true;
}

export function provenanceFromToolResult(name: string, result: unknown): SourceProvenance {
  const bound = boundToolResultProvenance(result);
  if (bound !== undefined) return bound;
  const value = payloadOf(result);
  if (isErrorOrCap(value) || !isNonEmptyData(value)) return EMPTY_PROVENANCE;
  if (name === "intervals_fetch_activity" || name === "intervals_fetch_activities") {
    return provenanceForSourceBearingData(value);
  }
  if (
    name === "intervals_fetch_wellness" ||
    name === "intervals_fetch_athlete" ||
    name === "intervals_fetch_streams" ||
    name === "intervals_list_events"
  ) {
    return UNKNOWN_PROVENANCE;
  }
  return EMPTY_PROVENANCE;
}

export function toolResultIsVisibleData(result: unknown): boolean {
  const value = payloadOf(result);
  return !isErrorOrCap(value) && isNonEmptyData(value);
}
