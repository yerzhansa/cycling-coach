import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

export interface SourceProvenance {
  readonly garmin: boolean;
  readonly nonGarmin: boolean;
  readonly unknown: boolean;
}

export const EMPTY_PROVENANCE: SourceProvenance = Object.freeze({
  garmin: false,
  nonGarmin: false,
  unknown: false,
});

export const UNKNOWN_PROVENANCE: SourceProvenance = Object.freeze({
  garmin: false,
  nonGarmin: false,
  unknown: true,
});

const NON_GARMIN_SOURCES = new Set([
  "POLAR",
  "SUUNTO",
  "COROS",
  "WAHOO",
  "ZWIFT",
  "ZEPP",
  "CONCEPT2",
  "HUAWEI",
]);

export function unionProvenance(
  ...values: readonly (SourceProvenance | undefined)[]
): SourceProvenance {
  let garmin = false;
  let nonGarmin = false;
  let unknown = false;
  for (const value of values) {
    if (value === undefined) continue;
    garmin ||= value.garmin;
    nonGarmin ||= value.nonGarmin;
    unknown ||= value.unknown;
  }
  return { garmin, nonGarmin, unknown };
}

export function classifyTrustedSource(source: unknown): SourceProvenance {
  if (source === "GARMIN_CONNECT") return { garmin: true, nonGarmin: false, unknown: false };
  if (typeof source === "string" && NON_GARMIN_SOURCES.has(source)) {
    return { garmin: false, nonGarmin: true, unknown: false };
  }
  return UNKNOWN_PROVENANCE;
}

export function classifyActivity(value: unknown): SourceProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return UNKNOWN_PROVENANCE;
  }
  return classifyTrustedSource((value as Record<string, unknown>).source);
}

export function classifyActivities(values: readonly unknown[]): SourceProvenance {
  return values.reduce<SourceProvenance>(
    (all, value) => unionProvenance(all, classifyActivity(value)),
    EMPTY_PROVENANCE,
  );
}

export function isNonEmptyData(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value) || typeof value === "string") return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export function provenanceForSourceBearingData(value: unknown): SourceProvenance {
  if (!isNonEmptyData(value)) return EMPTY_PROVENANCE;
  if (Array.isArray(value)) return classifyActivities(value);
  return classifyActivity(value);
}

export function isSourceProvenance(value: unknown): value is SourceProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.garmin === "boolean" &&
    typeof record.nonGarmin === "boolean" &&
    typeof record.unknown === "boolean"
  );
}

export function contentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const messageProvenance = new WeakMap<object, SourceProvenance>();

export function setMessageProvenance(
  message: ModelMessage,
  provenance: SourceProvenance,
): ModelMessage {
  messageProvenance.set(message as object, provenance);
  return message;
}

export function getMessageProvenance(message: ModelMessage): SourceProvenance {
  return messageProvenance.get(message as object) ?? UNKNOWN_PROVENANCE;
}

export function provenanceOfMessages(messages: readonly ModelMessage[]): SourceProvenance {
  return messages.reduce<SourceProvenance>(
    (all, message) => unionProvenance(all, getMessageProvenance(message)),
    EMPTY_PROVENANCE,
  );
}
