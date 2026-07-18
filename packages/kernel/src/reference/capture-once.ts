import { canonicalJson } from "../archive/canonical.js";
import { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";
import { FixtureSchema, type FixtureShape } from "./schemas/inputs.js";

export interface CompareReferenceCaptureInput {
  readonly direct: FixtureShape;
  readonly projected: FixtureShape;
  readonly frozenNow: string;
}

export interface ReferenceCaptureComparison {
  readonly fixtureBytesEqual: boolean;
  readonly metricMapsComplete: boolean;
  readonly metricBytesEqual: boolean;
  readonly registryKeyCount: number;
  readonly directMetricExceptionKeys: readonly string[];
  readonly projectedMetricExceptionKeys: readonly string[];
  readonly fixtureMismatchFamilies: readonly string[];
  readonly metricMismatchKeys: readonly string[];
  readonly directFamilyCounts: Readonly<Record<string, number>>;
  readonly projectedFamilyCounts: Readonly<Record<string, number>>;
}

const encoder = new TextEncoder();

function bytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareBinary(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function sortedUnion(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort(compareBinary);
}

function familyCount(fixture: FixtureShape, key: string): number {
  if (!Object.hasOwn(fixture, key)) return 0;
  const value = (fixture as Readonly<Record<string, unknown>>)[key];
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  return 1;
}

function frozenCounts(fixture: FixtureShape, keys: readonly string[]): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, familyCount(fixture, key)])));
}

export function compareReferenceCapture(input: CompareReferenceCaptureInput): ReferenceCaptureComparison {
  const direct = FixtureSchema.parse(input.direct);
  const projected = FixtureSchema.parse(input.projected);
  const fixtureBytesEqual = equalBytes(bytes(direct), bytes(projected));
  const fixtureKeys = sortedUnion(Object.keys(direct), Object.keys(projected));
  const fixtureMismatchFamilies = fixtureBytesEqual
    ? []
    : fixtureKeys.filter((key) => !equalBytes(
      bytes((direct as Readonly<Record<string, unknown>>)[key]),
      bytes((projected as Readonly<Record<string, unknown>>)[key]),
    ));

  const directMetrics: Record<string, unknown> = {};
  const projectedMetrics: Record<string, unknown> = {};
  const directMetricExceptionKeys: string[] = [];
  const projectedMetricExceptionKeys: string[] = [];
  const registryEntries = Object.entries(METRIC_REGISTRY);
  for (const [key, entry] of registryEntries) {
    try { directMetrics[key] = entry.compute({ fixture: direct, frozenNow: input.frozenNow }); }
    catch { directMetricExceptionKeys.push(key); }
    try { projectedMetrics[key] = entry.compute({ fixture: projected, frozenNow: input.frozenNow }); }
    catch { projectedMetricExceptionKeys.push(key); }
  }

  const registryKeys = registryEntries.map(([key]) => key);
  const metricMapsComplete = directMetricExceptionKeys.length === 0
    && projectedMetricExceptionKeys.length === 0
    && Object.keys(directMetrics).length === registryKeys.length
    && Object.keys(projectedMetrics).length === registryKeys.length
    && registryKeys.every((key) => Object.hasOwn(directMetrics, key) && Object.hasOwn(projectedMetrics, key));
  const metricBytesEqual = metricMapsComplete && equalBytes(bytes(directMetrics), bytes(projectedMetrics));
  const metricMismatchKeys = metricMapsComplete && !metricBytesEqual
    ? [...registryKeys].sort(compareBinary).filter((key) => !equalBytes(bytes(directMetrics[key]), bytes(projectedMetrics[key])))
    : [];

  return Object.freeze({
    fixtureBytesEqual,
    metricMapsComplete,
    metricBytesEqual,
    registryKeyCount: registryEntries.length,
    directMetricExceptionKeys: Object.freeze(directMetricExceptionKeys),
    projectedMetricExceptionKeys: Object.freeze(projectedMetricExceptionKeys),
    fixtureMismatchFamilies: Object.freeze(fixtureMismatchFamilies),
    metricMismatchKeys: Object.freeze(metricMismatchKeys),
    directFamilyCounts: frozenCounts(direct, fixtureKeys),
    projectedFamilyCounts: frozenCounts(projected, fixtureKeys),
  });
}
