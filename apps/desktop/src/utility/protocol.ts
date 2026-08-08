import type {
  AppSupervisedEnduragentResult,
  ReadinessFailureStatus,
} from "@enduragent/coach/enduragent";

export type UtilityTerminalFrame = {
  readonly type: "terminal";
  readonly exitCode: number;
  readonly readinessFailure?: ReadinessFailureStatus;
};

const DESKTOP_APP_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isDesktopAppVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && DESKTOP_APP_VERSION_RE.test(value);
}

export function createUtilityTerminalFrame(
  result: AppSupervisedEnduragentResult,
): UtilityTerminalFrame {
  return {
    type: "terminal",
    exitCode: result.exitCode,
    ...(result.readinessFailure === undefined ? {} : { readinessFailure: result.readinessFailure }),
  };
}
