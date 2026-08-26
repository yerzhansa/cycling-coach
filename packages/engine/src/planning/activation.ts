import type {
  ApprovePlanDraftResult,
  PlanConversationRepository,
} from "@enduragent/kernel/planning";

export interface ActivatePlanDraftInput {
  readonly draftRevisionId: string;
  readonly expectedRevision: number;
}

export interface PlanActivationIdentity {
  deviceId(): Promise<string>;
  hlcStamp(): { readonly physicalMs: number; readonly counter: number };
}

export async function activatePlanDraft(
  input: ActivatePlanDraftInput,
  dependencies: {
    readonly drafts: PlanConversationRepository;
    readonly identity: PlanActivationIdentity;
  },
): Promise<ApprovePlanDraftResult> {
  const stamp = dependencies.identity.hlcStamp();
  return dependencies.drafts.approveDraft({
    draftRevisionId: input.draftRevisionId,
    expectedRevision: input.expectedRevision,
    updatedAtMs: stamp.physicalMs,
    deviceId: await dependencies.identity.deviceId(),
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
}
