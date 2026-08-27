import type { PlanReplacementRecord, PlanReplacementRepository } from "@enduragent/kernel/planning";

export interface ApproveReplacementInput {
  readonly replacementId: string;
  readonly previousPlanId: string;
  readonly replacementPlanId: string;
  readonly draftRevisionId: string;
  readonly expectedRevision: number;
  readonly cleanupJobId: string;
  readonly windowStartDateKey: number;
  readonly windowEndDateKey: number;
}

export interface PlanReplacementIdentity {
  deviceId(): Promise<string>;
  hlcStamp(): { readonly physicalMs: number; readonly counter: number };
}

export async function approvePlanReplacement(
  input: ApproveReplacementInput,
  dependencies: {
    readonly replacements: PlanReplacementRepository;
    readonly identity: PlanReplacementIdentity;
  },
): Promise<PlanReplacementRecord> {
  const stamp = dependencies.identity.hlcStamp();
  return dependencies.replacements.approve({
    id: input.replacementId,
    previousPlanId: input.previousPlanId,
    replacementPlanId: input.replacementPlanId,
    draftRevisionId: input.draftRevisionId,
    expectedRevision: input.expectedRevision,
    cleanupJobId: input.cleanupJobId,
    windowStartDateKey: input.windowStartDateKey,
    windowEndDateKey: input.windowEndDateKey,
    updatedAtMs: stamp.physicalMs,
    deviceId: await dependencies.identity.deviceId(),
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
}
