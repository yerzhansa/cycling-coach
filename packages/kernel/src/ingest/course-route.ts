export type CourseRouteFormat = "gpx" | "fit";

export interface CourseRoutePoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly elevationM: number | null;
}

export interface CourseRouteSegment {
  readonly points: readonly CourseRoutePoint[];
}

export interface CourseRoute {
  readonly format: CourseRouteFormat;
  readonly segments: readonly CourseRouteSegment[];
}

export type CourseRouteParseResult =
  | { readonly ok: true; readonly route: CourseRoute }
  | {
      readonly ok: false;
      readonly reason: "unreadable" | "route-missing";
      readonly detail: string;
    };
