import type { PlanStatus, RaceCourseSnapshot } from "@enduragent/kernel/planning";

export type RaceCourseLifecycleKind =
  | "course-picker"
  | "course-parsing"
  | "course-invalid"
  | "course-missing-elevation"
  | "course-recalculating"
  | "course-recalculation-failed"
  | "course-ready";

interface RaceCourseBaseState<Draft> {
  readonly kind: RaceCourseLifecycleKind;
  readonly draft: Draft;
  readonly acceptedCourse: RaceCourseSnapshot | null;
}

export interface RaceCoursePickerState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-picker";
}

export interface RaceCourseParsingState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-parsing";
  readonly fileName: string;
  readonly replacing: boolean;
}

export interface RaceCourseInvalidState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-invalid";
  readonly fileName: string;
  readonly detail: string;
}

export interface RaceCourseMissingElevationState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-missing-elevation";
  readonly candidateCourse: RaceCourseSnapshot;
}

export interface RaceCourseRecalculatingState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-recalculating";
  readonly candidateCourse: RaceCourseSnapshot | null;
}

export interface RaceCourseRecalculationFailedState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-recalculation-failed";
  readonly candidateCourse: RaceCourseSnapshot | null;
  readonly detail: string;
}

export interface RaceCourseReadyState<Draft> extends RaceCourseBaseState<Draft> {
  readonly kind: "course-ready";
}

export type RaceCourseLifecycleState<Draft> =
  | RaceCoursePickerState<Draft>
  | RaceCourseParsingState<Draft>
  | RaceCourseInvalidState<Draft>
  | RaceCourseMissingElevationState<Draft>
  | RaceCourseRecalculatingState<Draft>
  | RaceCourseRecalculationFailedState<Draft>
  | RaceCourseReadyState<Draft>;

export class RaceCourseLifecycleError extends Error {
  readonly code: "course-frozen" | "invalid-transition";

  constructor(code: RaceCourseLifecycleError["code"]) {
    super(`Race Course lifecycle rejected: ${code}`);
    this.name = "RaceCourseLifecycleError";
    this.code = code;
  }
}

function frozen<Draft, State extends RaceCourseLifecycleState<Draft>>(state: State): State {
  return Object.freeze(state);
}

export function openRaceCoursePicker<Draft>(input: {
  readonly planStatus: PlanStatus;
  readonly draft: Draft;
  readonly acceptedCourse: RaceCourseSnapshot | null;
}): RaceCoursePickerState<Draft> {
  if (input.planStatus !== "draft") throw new RaceCourseLifecycleError("course-frozen");
  return frozen({ kind: "course-picker", draft: input.draft, acceptedCourse: input.acceptedCourse });
}

export function beginRaceCourseParsing<Draft>(
  state: RaceCoursePickerState<Draft>,
  fileName: string,
): RaceCourseParsingState<Draft> {
  if (state.kind !== "course-picker" || fileName.trim().length === 0) {
    throw new RaceCourseLifecycleError("invalid-transition");
  }
  return frozen({
    kind: "course-parsing",
    draft: state.draft,
    acceptedCourse: state.acceptedCourse,
    fileName,
    replacing: state.acceptedCourse !== null,
  });
}

export function rejectRaceCourseFile<Draft>(
  state: RaceCourseParsingState<Draft>,
  detail: string,
): RaceCourseInvalidState<Draft> {
  if (state.kind !== "course-parsing" || detail.trim().length === 0) {
    throw new RaceCourseLifecycleError("invalid-transition");
  }
  return frozen({
    kind: "course-invalid",
    draft: state.draft,
    acceptedCourse: state.acceptedCourse,
    fileName: state.fileName,
    detail,
  });
}

export function acceptParsedRaceCourse<Draft>(
  state: RaceCourseParsingState<Draft>,
  candidateCourse: RaceCourseSnapshot,
): RaceCourseMissingElevationState<Draft> | RaceCourseRecalculatingState<Draft> {
  if (state.kind !== "course-parsing") throw new RaceCourseLifecycleError("invalid-transition");
  if (candidateCourse.preview.elevationStatus === "unavailable") {
    return frozen({
      kind: "course-missing-elevation",
      draft: state.draft,
      acceptedCourse: state.acceptedCourse,
      candidateCourse,
    });
  }
  return frozen({
    kind: "course-recalculating",
    draft: state.draft,
    acceptedCourse: state.acceptedCourse,
    candidateCourse,
  });
}

export function useRouteWithoutElevation<Draft>(
  state: RaceCourseMissingElevationState<Draft>,
): RaceCourseRecalculatingState<Draft> {
  if (state.kind !== "course-missing-elevation") {
    throw new RaceCourseLifecycleError("invalid-transition");
  }
  return frozen({
    kind: "course-recalculating",
    draft: state.draft,
    acceptedCourse: state.acceptedCourse,
    candidateCourse: state.candidateCourse,
  });
}

export function beginRaceCourseRemoval<Draft>(
  state: RaceCoursePickerState<Draft> | RaceCourseInvalidState<Draft> | RaceCourseMissingElevationState<Draft>,
): RaceCourseRecalculatingState<Draft> {
  return frozen({
    kind: "course-recalculating",
    draft: state.draft,
    acceptedCourse: state.acceptedCourse,
    candidateCourse: null,
  });
}

export function failRaceCourseRecalculation<Draft>(
  state: RaceCourseRecalculatingState<Draft>,
  detail: string,
): RaceCourseRecalculationFailedState<Draft> {
  if (state.kind !== "course-recalculating" || detail.trim().length === 0) {
    throw new RaceCourseLifecycleError("invalid-transition");
  }
  return frozen({ ...state, kind: "course-recalculation-failed", detail });
}

export function retryRaceCourseRecalculation<Draft>(
  state: RaceCourseRecalculationFailedState<Draft>,
): RaceCourseRecalculatingState<Draft> {
  if (state.kind !== "course-recalculation-failed") {
    throw new RaceCourseLifecycleError("invalid-transition");
  }
  return frozen({
    kind: "course-recalculating",
    draft: state.draft,
    acceptedCourse: state.acceptedCourse,
    candidateCourse: state.candidateCourse,
  });
}

export function completeRaceCourseRecalculation<Draft>(
  state: RaceCourseRecalculatingState<Draft>,
  input: {
    readonly planStatus: PlanStatus;
    readonly recalculatedDraft: Draft;
  },
): RaceCourseReadyState<Draft> {
  if (state.kind !== "course-recalculating") {
    throw new RaceCourseLifecycleError("invalid-transition");
  }
  if (input.planStatus !== "draft") throw new RaceCourseLifecycleError("course-frozen");
  return frozen({
    kind: "course-ready",
    draft: input.recalculatedDraft,
    acceptedCourse: state.candidateCourse,
  });
}
