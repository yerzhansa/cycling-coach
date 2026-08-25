import { createHash } from "node:crypto";
import {
  childElements,
  parseXmlDocument,
  preprocessXml,
  validateDocumentShell,
} from "@enduragent/kernel/ingest";
import {
  parseNormalizedWorkoutSet,
  validateWorkoutParserLimits,
  type NormalizedWorkoutSegment,
  type NormalizedWorkoutSet,
  type WorkoutCadenceRange,
  type WorkoutParserLimits,
  type WorkoutPowerTarget,
  type WorkoutSourceFormat,
} from "./types.js";

export const CYCLING_WORKOUT_PARSER_VERSION = "cycling-workout-v1";

export type WorkoutParseFailure =
  | "invalid_utf8"
  | "unsafe_xml"
  | "malformed_xml"
  | "invalid_structure"
  | "invalid_timing"
  | "invalid_target"
  | "limit_exceeded"
  | "unsupported_construct";

export class WorkoutParseError extends Error {
  constructor(readonly code: WorkoutParseFailure) {
    super("planned workout could not be parsed");
    this.name = "WorkoutParseError";
  }
}

export interface ParseWorkoutInput {
  readonly bytes: Uint8Array;
  readonly sourceFormat: WorkoutSourceFormat;
  readonly sourceSha256: string;
  readonly limits: WorkoutParserLimits;
}

type XmlElement = ReturnType<typeof validateDocumentShell>;

const SHA256 = /^[0-9a-f]{64}$/u;
const HEADER_START = "[COURSE HEADER]";
const HEADER_END = "[END COURSE HEADER]";
const DATA_START = "[COURSE DATA]";
const DATA_END = "[END COURSE DATA]";

function fail(code: WorkoutParseFailure): never {
  throw new WorkoutParseError(code);
}

function hash(...parts: readonly (string | number)[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(String(part), "utf8").update("\0", "utf8");
  return digest.digest("hex");
}

export function workoutSetId(sourceFormat: WorkoutSourceFormat, sourceSha256: string): string {
  if (!SHA256.test(sourceSha256)) return fail("invalid_structure");
  return hash("workout-set", sourceFormat, sourceSha256);
}

export function hasCanonicalWorkoutIdentities(
  set: NormalizedWorkoutSet,
  sourceSha256: string,
): boolean {
  const expectedSetId = workoutSetId(set.sourceFormat, sourceSha256);
  if (set.setId !== expectedSetId || set.selectedWorkoutId !== null) return false;
  return set.workouts.every((workout, workoutIndex) => {
    const expectedWorkoutId = hash("workout", expectedSetId, workoutIndex);
    return (
      workout.workoutId === expectedWorkoutId &&
      workout.segments.every(
        (segment, segmentIndex) =>
          segment.segmentId === hash("segment", expectedWorkoutId, segmentIndex),
      )
    );
  });
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("invalid_utf8");
  }
}

function finite(value: string | null, code: WorkoutParseFailure): number {
  if (value === null || value.trim().length === 0) return fail(code);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fail(code);
  return parsed;
}

function positive(value: string | null, code: WorkoutParseFailure): number {
  const parsed = finite(value, code);
  if (parsed <= 0) return fail(code);
  return parsed;
}

function positiveSeconds(value: string | null): number {
  const seconds = positive(value, "invalid_timing");
  if (!Number.isSafeInteger(seconds)) return fail("invalid_timing");
  return seconds;
}

function positiveInteger(value: string | null, code: WorkoutParseFailure): number {
  const parsed = positive(value, code);
  if (!Number.isSafeInteger(parsed)) return fail(code);
  return parsed;
}

function cleanText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return null;
  if (normalized.length > max) return fail("limit_exceeded");
  return normalized;
}

function scalarChild(parent: XmlElement, name: string, max: number): string | null {
  const matches = childElements(parent).filter((element) => element.localName === name);
  if (matches.length > 1) return fail("invalid_structure");
  const element = matches[0];
  if (element === undefined) return null;
  if (childElements(element).length > 0) return fail("invalid_structure");
  return cleanText(element.textContent, max);
}

function ordered(low: number, high: number): { readonly low: number; readonly high: number } {
  if (low <= 0 || high <= 0) return fail("invalid_target");
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

function ftpFraction(low: number, high = low): WorkoutPowerTarget {
  return { kind: "ftp_fraction_range", ...ordered(low, high) };
}

function cadence(low: number, high = low): WorkoutCadenceRange {
  return ordered(low, high);
}

function optionalCadence(
  element: XmlElement,
  lowName = "Cadence",
  highName = lowName,
): WorkoutCadenceRange | undefined {
  const lowRaw = element.getAttribute(lowName);
  const highRaw = element.getAttribute(highName);
  if (lowRaw === null && highRaw === null) return undefined;
  const low = positive(lowRaw ?? highRaw, "invalid_target");
  const high = positive(highRaw ?? lowRaw, "invalid_target");
  return cadence(low, high);
}

function rawSegment(
  kind: NormalizedWorkoutSegment["kind"],
  seconds: number,
  power?: WorkoutPowerTarget,
  cadenceRpm?: WorkoutCadenceRange,
): Omit<NormalizedWorkoutSegment, "segmentId"> {
  return {
    kind,
    seconds,
    ...(power === undefined ? {} : { power }),
    ...(cadenceRpm === undefined ? {} : { cadenceRpm }),
  };
}

function zwoPower(element: XmlElement, lowName = "Power", highName = lowName): WorkoutPowerTarget {
  const lowRaw = element.getAttribute(lowName);
  const highRaw = element.getAttribute(highName);
  if (lowRaw === null && highRaw === null) return fail("invalid_target");
  const low = positive(lowRaw ?? highRaw, "invalid_target");
  const high = positive(highRaw ?? lowRaw, "invalid_target");
  return ftpFraction(low, high);
}

function parseZwoSegments(
  workout: XmlElement,
  maximum: number,
): readonly Omit<NormalizedWorkoutSegment, "segmentId">[] {
  const result: Omit<NormalizedWorkoutSegment, "segmentId">[] = [];
  const add = (...segments: readonly Omit<NormalizedWorkoutSegment, "segmentId">[]): void => {
    if (result.length + segments.length > maximum) return fail("limit_exceeded");
    result.push(...segments);
  };
  for (const element of childElements(workout)) {
    switch (element.localName) {
      case "Warmup":
      case "Cooldown":
      case "Ramp": {
        const seconds = positiveSeconds(element.getAttribute("Duration"));
        add(
          rawSegment(
            "ramp",
            seconds,
            zwoPower(element, "PowerLow", "PowerHigh"),
            optionalCadence(element, "CadenceLow", "CadenceHigh") ?? optionalCadence(element),
          ),
        );
        break;
      }
      case "SteadyState": {
        const seconds = positiveSeconds(element.getAttribute("Duration"));
        const power =
          element.getAttribute("Power") === null
            ? zwoPower(element, "PowerLow", "PowerHigh")
            : zwoPower(element);
        add(
          rawSegment(
            power.low === power.high ? "steady" : "ramp",
            seconds,
            power,
            optionalCadence(element, "CadenceLow", "CadenceHigh") ?? optionalCadence(element),
          ),
        );
        break;
      }
      case "FreeRide": {
        add(
          rawSegment(
            "free_ride",
            positiveSeconds(element.getAttribute("Duration")),
            undefined,
            optionalCadence(element),
          ),
        );
        break;
      }
      case "IntervalsT": {
        const repeats = positiveInteger(element.getAttribute("Repeat"), "invalid_timing");
        const on = rawSegment(
          "steady",
          positiveSeconds(element.getAttribute("OnDuration")),
          zwoPower(element, "OnPower"),
          optionalCadence(element, "OnCadence"),
        );
        const off = rawSegment(
          "steady",
          positiveSeconds(element.getAttribute("OffDuration")),
          zwoPower(element, "OffPower"),
          optionalCadence(element, "OffCadence"),
        );
        if (repeats > Math.floor((maximum - result.length) / 2)) return fail("limit_exceeded");
        for (let repeat = 0; repeat < repeats; repeat += 1) add(on, off);
        break;
      }
      case "textevent":
        break;
      default:
        return fail("unsupported_construct");
    }
  }
  return result;
}

function parseZwo(
  text: string,
  setId: string,
  limits: WorkoutParserLimits,
): Omit<NormalizedWorkoutSet, "selectedWorkoutId"> {
  let root: XmlElement;
  try {
    root = validateDocumentShell(parseXmlDocument(preprocessXml(text)));
  } catch {
    return fail(/<!DOCTYPE|<!ENTITY|<\?(?!xml\b)/iu.test(text) ? "unsafe_xml" : "malformed_xml");
  }
  if (root.localName !== "workout_file" || root.namespaceURI) return fail("invalid_structure");
  const sportType = scalarChild(root, "sportType", 32)?.toLowerCase();
  if (
    sportType !== undefined &&
    sportType !== null &&
    sportType !== "bike" &&
    sportType !== "cycling"
  ) {
    return fail("invalid_structure");
  }
  const workoutElements = childElements(root).filter((element) => element.localName === "workout");
  if (workoutElements.length !== 1) return fail("invalid_structure");
  const rawSegments = parseZwoSegments(workoutElements[0]!, limits.segmentsPerWorkout);
  if (rawSegments.length < 1 || rawSegments.length > limits.segmentsPerWorkout) {
    return fail("limit_exceeded");
  }
  const title = scalarChild(root, "name", limits.titleChars) ?? "Cycling workout";
  const purpose = scalarChild(root, "description", limits.purposeChars);
  const workoutId = hash("workout", setId, 0);
  const segments = rawSegments.map((segment, index) => ({
    ...segment,
    segmentId: hash("segment", workoutId, index),
  }));
  return {
    schemaVersion: 1,
    setId,
    sourceFormat: "zwo",
    parserVersion: CYCLING_WORKOUT_PARSER_VERSION,
    workouts: [
      {
        workoutId,
        title,
        sport: "cycling",
        durationSeconds: segments.reduce((sum, segment) => sum + segment.seconds, 0),
        purpose,
        segments,
      },
    ],
    diagnostics: [],
  };
}

interface CoursePoint {
  readonly seconds: number;
  readonly target: number;
  readonly cadence?: number;
}

function markerIndex(lines: readonly string[], marker: string): number {
  return lines.findIndex((line) => line.toUpperCase() === marker);
}

function parseCourse(
  text: string,
  format: "mrc" | "erg",
  setId: string,
  limits: WorkoutParserLimits,
): Omit<NormalizedWorkoutSet, "selectedWorkoutId"> {
  const lines = text
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const headerStart = markerIndex(lines, HEADER_START);
  const headerEnd = markerIndex(lines, HEADER_END);
  const dataStart = markerIndex(lines, DATA_START);
  const dataEnd = markerIndex(lines, DATA_END);
  if (
    headerStart !== 0 ||
    headerEnd <= headerStart ||
    dataStart <= headerEnd ||
    dataEnd <= dataStart ||
    lines.slice(dataEnd + 1).some((line) => line.length > 0)
  ) {
    return fail("invalid_structure");
  }
  const headers = new Map<string, string>();
  let declaredMode: string | undefined;
  const diagnostics: string[] = [];
  for (const line of lines.slice(headerStart + 1, headerEnd)) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^MINUTES\s+(?:PERCENT|WATTS)$/iu.test(line)) {
      declaredMode = line.toUpperCase().replace(/\s+/gu, " ");
      continue;
    }
    const split = line.indexOf("=");
    if (split < 1) return fail("invalid_structure");
    const key = line.slice(0, split).trim().toUpperCase();
    const value = line.slice(split + 1).trim();
    if (key.length === 0 || value.length === 0 || headers.has(key)) {
      return fail("invalid_structure");
    }
    headers.set(key, value);
    if (
      !["VERSION", "UNITS", "DESCRIPTION", "FILE NAME", "COURSE NAME", "NAME", "FTP"].includes(key)
    ) {
      const diagnostic = `Ignored header: ${key}`;
      if (diagnostic.length > limits.diagnosticChars) return fail("limit_exceeded");
      diagnostics.push(diagnostic);
    }
  }
  const expectedMode = format === "mrc" ? "MINUTES PERCENT" : "MINUTES WATTS";
  if (declaredMode !== expectedMode) return fail("invalid_structure");
  if (diagnostics.length > limits.diagnostics) return fail("limit_exceeded");

  const points: CoursePoint[] = [];
  for (const line of lines.slice(dataStart + 1, dataEnd)) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const fields = line.split(/[\s,]+/u);
    if (fields.length < 2 || fields.length > 3) return fail("invalid_structure");
    const minutes = finite(fields[0] ?? null, "invalid_timing");
    const rawSeconds = minutes * 60;
    if (minutes < 0 || !Number.isSafeInteger(rawSeconds)) return fail("invalid_timing");
    const target = positive(fields[1] ?? null, "invalid_target");
    const cadenceValue =
      fields[2] === undefined ? undefined : positive(fields[2], "invalid_target");
    const previous = points.at(-1);
    if (previous !== undefined && rawSeconds < previous.seconds) return fail("invalid_timing");
    points.push({
      seconds: rawSeconds,
      target,
      ...(cadenceValue === undefined ? {} : { cadence: cadenceValue }),
    });
    if (points.length > limits.segmentsPerWorkout * 2 + 1) return fail("limit_exceeded");
  }
  if (points.length < 2 || points[0]?.seconds !== 0) return fail("invalid_timing");

  const rawSegments: Omit<NormalizedWorkoutSegment, "segmentId">[] = [];
  let current = points[0]!;
  for (const next of points.slice(1)) {
    if (next.seconds === current.seconds) {
      current = next;
      continue;
    }
    const seconds = next.seconds - current.seconds;
    const target = ordered(current.target, next.target);
    const power: WorkoutPowerTarget =
      format === "mrc"
        ? { kind: "ftp_percent_range", ...target }
        : { kind: "watts_range", ...target };
    const cadenceRpm =
      current.cadence === undefined && next.cadence === undefined
        ? undefined
        : cadence(
            Math.min(current.cadence ?? next.cadence!, next.cadence ?? current.cadence!),
            Math.max(current.cadence ?? next.cadence!, next.cadence ?? current.cadence!),
          );
    rawSegments.push(
      rawSegment(current.target === next.target ? "steady" : "ramp", seconds, power, cadenceRpm),
    );
    current = next;
  }
  if (rawSegments.length < 1 || rawSegments.length > limits.segmentsPerWorkout) {
    return fail("limit_exceeded");
  }
  const workoutId = hash("workout", setId, 0);
  const segments = rawSegments.map((segment, index) => ({
    ...segment,
    segmentId: hash("segment", workoutId, index),
  }));
  const purpose = cleanText(headers.get("DESCRIPTION"), limits.purposeChars);
  const title =
    cleanText(
      headers.get("FILE NAME") ?? headers.get("COURSE NAME") ?? headers.get("NAME"),
      limits.titleChars,
    ) ?? `${format.toUpperCase()} cycling workout`;
  return {
    schemaVersion: 1,
    setId,
    sourceFormat: format,
    parserVersion: CYCLING_WORKOUT_PARSER_VERSION,
    workouts: [
      {
        workoutId,
        title,
        sport: "cycling",
        durationSeconds: segments.reduce((sum, segment) => sum + segment.seconds, 0),
        purpose,
        segments,
      },
    ],
    diagnostics,
  };
}

export function parseWorkoutBytes(input: ParseWorkoutInput): NormalizedWorkoutSet {
  validateWorkoutParserLimits(input.limits);
  if (!SHA256.test(input.sourceSha256) || input.bytes.byteLength < 1) {
    return fail("invalid_structure");
  }
  const setId = workoutSetId(input.sourceFormat, input.sourceSha256);
  const text = decode(input.bytes);
  const parsed =
    input.sourceFormat === "zwo"
      ? parseZwo(text, setId, input.limits)
      : parseCourse(text, input.sourceFormat, setId, input.limits);
  return parseNormalizedWorkoutSet({ ...parsed, selectedWorkoutId: null }, input.limits);
}
