import type { CourseRoute, CourseRoutePoint } from "@enduragent/kernel/ingest";

export interface CyclingRaceCourseInterpretation {
  readonly pointCount: number;
  readonly distanceM: number;
  readonly elevationGainM: number | null;
  readonly elevationStatus: "available" | "unavailable";
}

export class CyclingRaceCourseError extends Error {
  readonly code: "invalid-route";

  constructor() {
    super("cycling Race Course rejected: invalid-route");
    this.name = "CyclingRaceCourseError";
    this.code = "invalid-route";
  }
}

const EARTH_RADIUS_M = 6_371_008.8;

function radians(value: number): number {
  return value * Math.PI / 180;
}

function distanceBetween(left: CourseRoutePoint, right: CourseRoutePoint): number {
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(value)));
}

function validPoint(point: CourseRoutePoint): boolean {
  return Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && Number.isFinite(point.longitude)
    && point.longitude >= -180
    && point.longitude <= 180
    && (point.elevationM === null || Number.isFinite(point.elevationM));
}

export function interpretCyclingRaceCourse(route: CourseRoute): CyclingRaceCourseInterpretation {
  if (
    (route.format !== "gpx" && route.format !== "fit")
    || route.segments.length === 0
    || !route.segments.some((segment) => segment.points.length >= 2)
    || route.segments.some((segment) => segment.points.some((point) => !validPoint(point)))
  ) {
    throw new CyclingRaceCourseError();
  }
  let pointCount = 0;
  let distanceM = 0;
  let elevationGainM = 0;
  let elevationAvailable = true;
  for (const segment of route.segments) {
    pointCount += segment.points.length;
    for (let index = 0; index < segment.points.length; index += 1) {
      const current = segment.points[index]!;
      if (current.elevationM === null) elevationAvailable = false;
      if (index === 0) continue;
      const previous = segment.points[index - 1]!;
      distanceM += distanceBetween(previous, current);
      if (previous.elevationM === null || current.elevationM === null) {
        elevationAvailable = false;
      } else {
        elevationGainM += Math.max(0, current.elevationM - previous.elevationM);
      }
    }
  }
  if (!Number.isFinite(distanceM) || distanceM <= 0) throw new CyclingRaceCourseError();
  return Object.freeze({
    pointCount,
    distanceM,
    elevationGainM: elevationAvailable ? elevationGainM : null,
    elevationStatus: elevationAvailable ? "available" : "unavailable",
  });
}
