import {
  FitSourceError,
  type CourseRoute,
  type CourseRouteParseResult,
  type CourseRoutePoint,
  type CourseRouteSegment,
  type DecodedFitFile,
  type DecodedRecord,
} from "@enduragent/kernel/ingest";
import { createFitDecoder, type FitDecoder } from "./fit-decoder.js";

function point(record: DecodedRecord): CourseRoutePoint | null {
  if (record.positionLat === null && record.positionLong === null) return null;
  if (record.positionLat === null || record.positionLong === null) {
    throw new FitSourceError("invalid_numeric");
  }
  const elevationM = record.enhancedAltitude ?? record.altitude;
  if (
    !Number.isFinite(record.positionLat)
    || record.positionLat < -90
    || record.positionLat > 90
    || !Number.isFinite(record.positionLong)
    || record.positionLong < -180
    || record.positionLong > 180
    || (elevationM !== null && !Number.isFinite(elevationM))
  ) {
    throw new FitSourceError("invalid_numeric");
  }
  return Object.freeze({
    latitude: Object.is(record.positionLat, -0) ? 0 : record.positionLat,
    longitude: Object.is(record.positionLong, -0) ? 0 : record.positionLong,
    elevationM: elevationM === null || !Object.is(elevationM, -0) ? elevationM : 0,
  });
}

export function fitCourseRoute(decoded: DecodedFitFile): CourseRouteParseResult {
  try {
    const segments: CourseRouteSegment[] = [];
    let current: CourseRoutePoint[] = [];
    const flush = (): void => {
      if (current.length > 0) segments.push(Object.freeze({ points: Object.freeze(current) }));
      current = [];
    };
    for (const record of decoded.records) {
      const value = point(record);
      if (value === null) flush();
      else current.push(value);
    }
    flush();
    if (!segments.some((segment) => segment.points.length >= 2)) {
      return { ok: false, reason: "route-missing", detail: "The FIT file does not contain a usable route." };
    }
    const route: CourseRoute = Object.freeze({ format: "fit", segments: Object.freeze(segments) });
    return { ok: true, route };
  } catch (error) {
    if (!(error instanceof FitSourceError)) throw error;
    return { ok: false, reason: "unreadable", detail: "The FIT route contains invalid values." };
  }
}

export async function parseFitCourse(
  bytes: Uint8Array,
  decoder: FitDecoder = createFitDecoder(),
): Promise<CourseRouteParseResult> {
  try {
    return fitCourseRoute(await decoder.decode(bytes));
  } catch {
    return { ok: false, reason: "unreadable", detail: "The FIT file could not be read." };
  }
}
