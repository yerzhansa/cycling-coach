import type { CourseRoute, CourseRouteFormat } from "../ingest/course-route.js";

export interface RaceCoursePreview {
  readonly pointCount: number;
  readonly distanceM: number;
  readonly elevationGainM: number | null;
  readonly elevationStatus: "available" | "unavailable";
}

export interface RaceCourseSnapshot {
  readonly fileName: string;
  readonly format: CourseRouteFormat;
  readonly route: CourseRoute;
  readonly preview: RaceCoursePreview;
}

export class RaceCourseSnapshotError extends Error {
  readonly code: "invalid-file-name" | "invalid-route" | "invalid-preview";

  constructor(code: RaceCourseSnapshotError["code"]) {
    super(`Race Course snapshot rejected: ${code}`);
    this.name = "RaceCourseSnapshotError";
    this.code = code;
  }
}

function frozenRoute(route: CourseRoute): CourseRoute {
  if (
    (route.format !== "gpx" && route.format !== "fit") ||
    route.segments.length === 0 ||
    !route.segments.some((segment) => segment.points.length >= 2)
  ) {
    throw new RaceCourseSnapshotError("invalid-route");
  }
  return Object.freeze({
    format: route.format,
    segments: Object.freeze(
      route.segments.map((segment) =>
        Object.freeze({
          points: Object.freeze(
            segment.points.map((point) => {
              if (
                !Number.isFinite(point.latitude) ||
                point.latitude < -90 ||
                point.latitude > 90 ||
                !Number.isFinite(point.longitude) ||
                point.longitude < -180 ||
                point.longitude > 180 ||
                (point.elevationM !== null && !Number.isFinite(point.elevationM))
              ) {
                throw new RaceCourseSnapshotError("invalid-route");
              }
              return Object.freeze({ ...point });
            }),
          ),
        }),
      ),
    ),
  });
}

export function createRaceCourseSnapshot(input: {
  readonly fileName: string;
  readonly route: CourseRoute;
  readonly preview: RaceCoursePreview;
}): RaceCourseSnapshot {
  if (input.fileName.trim().length === 0) throw new RaceCourseSnapshotError("invalid-file-name");
  const route = frozenRoute(input.route);
  const actualPointCount = route.segments.reduce((sum, segment) => sum + segment.points.length, 0);
  const preview = input.preview;
  if (
    !Number.isSafeInteger(preview.pointCount) ||
    preview.pointCount !== actualPointCount ||
    !Number.isFinite(preview.distanceM) ||
    preview.distanceM <= 0 ||
    (preview.elevationGainM !== null &&
      (!Number.isFinite(preview.elevationGainM) || preview.elevationGainM < 0)) ||
    (preview.elevationStatus !== "available" && preview.elevationStatus !== "unavailable") ||
    (preview.elevationStatus === "available") !== (preview.elevationGainM !== null)
  ) {
    throw new RaceCourseSnapshotError("invalid-preview");
  }
  return Object.freeze({
    fileName: input.fileName,
    format: route.format,
    route,
    preview: Object.freeze({ ...preview }),
  });
}

export function parseRaceCourseSnapshot(value: unknown): RaceCourseSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RaceCourseSnapshotError("invalid-route");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.fileName !== "string" ||
    input.route === null ||
    typeof input.route !== "object" ||
    Array.isArray(input.route) ||
    input.preview === null ||
    typeof input.preview !== "object" ||
    Array.isArray(input.preview)
  ) {
    throw new RaceCourseSnapshotError("invalid-route");
  }
  const route = input.route as Record<string, unknown>;
  const preview = input.preview as Record<string, unknown>;
  if (!Array.isArray(route.segments)) throw new RaceCourseSnapshotError("invalid-route");
  return createRaceCourseSnapshot({
    fileName: input.fileName,
    route: {
      format: route.format as CourseRouteFormat,
      segments: route.segments as CourseRoute["segments"],
    },
    preview: {
      pointCount: preview.pointCount as number,
      distanceM: preview.distanceM as number,
      elevationGainM: preview.elevationGainM as number | null,
      elevationStatus: preview.elevationStatus as RaceCoursePreview["elevationStatus"],
    },
  });
}
