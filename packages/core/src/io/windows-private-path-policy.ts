import {
  classifyPrivatePathDurability,
  classifyPrivatePathErrorCode,
  decidePrivatePathEntry,
  decidePrivatePathRead,
  type PrivatePathDurabilityClassification,
  type PrivatePathDurabilityStage,
  type PrivatePathEntryDecisionInput,
  type PrivatePathPolicyDecision,
  type PrivatePathPolicyErrorCategory,
  type PrivatePathReadDecisionInput,
} from "@enduragent/kernel/ports";

export type WindowsPrivatePathPolicyStage =
  | Exclude<PrivatePathDurabilityStage, "directory-sync">
  | "entry-check"
  | "read-check";

export class WindowsPrivatePathPolicyError extends Error {
  override readonly name = "WindowsPrivatePathPolicyError";
  readonly stage: WindowsPrivatePathPolicyStage;
  readonly category: PrivatePathPolicyErrorCategory;

  constructor(stage: WindowsPrivatePathPolicyStage, category: PrivatePathPolicyErrorCategory) {
    super("Windows private path policy failed");
    this.stage = stage;
    this.category = category;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function assertDecision(
  stage: WindowsPrivatePathPolicyStage,
  decision: PrivatePathPolicyDecision,
): void {
  if (decision.kind === "reject") {
    throw new WindowsPrivatePathPolicyError(stage, decision.category);
  }
}

export function classifyWindowsPrivatePathDurability(
  stage: PrivatePathDurabilityStage,
): PrivatePathDurabilityClassification {
  return classifyPrivatePathDurability({ platform: "windows", stage });
}

export function classifyWindowsPrivatePathFailure(
  stage: WindowsPrivatePathPolicyStage,
  error: unknown,
): WindowsPrivatePathPolicyError {
  if (error instanceof WindowsPrivatePathPolicyError) return error;
  return new WindowsPrivatePathPolicyError(stage, classifyPrivatePathErrorCode(errorCode(error)));
}

export function assertWindowsPrivatePathEntry(input: PrivatePathEntryDecisionInput): void {
  assertDecision("entry-check", decidePrivatePathEntry(input));
}

export function assertWindowsPrivatePathRead(input: PrivatePathReadDecisionInput): void {
  assertDecision("read-check", decidePrivatePathRead(input));
}
