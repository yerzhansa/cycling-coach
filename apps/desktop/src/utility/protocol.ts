import type {
  AppSupervisedEnduragentResult,
  ReadinessFailureStatus,
} from "@enduragent/coach/enduragent";

export type UtilityTerminalFrame = {
  readonly type: "terminal";
  readonly exitCode: number;
  readonly readinessFailure?: ReadinessFailureStatus;
};

export function createUtilityTerminalFrame(
  result: AppSupervisedEnduragentResult,
): UtilityTerminalFrame {
  return {
    type: "terminal",
    exitCode: result.exitCode,
    ...(result.readinessFailure === undefined ? {} : { readinessFailure: result.readinessFailure }),
  };
}
