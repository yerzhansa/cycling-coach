import type {
  CoachDecisionAnswer,
  PlanError,
  PlanHydrationState,
  PlanProgressEvent,
  PlanReadModel,
  PlanTransitionId,
} from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { EnduragentState } from "./store.js";
import { EMPTY_CHAT_SURFACE, type ChatSurfaceState } from "./chat-slice.js";

export type PlanTransitionState =
  | { readonly status: "idle" }
  | {
      readonly status: "submitting";
      readonly commandId: string;
      readonly transitionId: PlanTransitionId;
    }
  | {
      readonly status: "running";
      readonly commandId: string;
      readonly transitionId: PlanTransitionId;
      readonly operationId: string;
      readonly progress: PlanProgressEvent | null;
    }
  | {
      readonly status: "failed";
      readonly commandId: string | null;
      readonly transitionId: PlanTransitionId | null;
      readonly error: PlanError;
    };

export interface PlanSurfaceState {
  readonly hydration: PlanHydrationState;
  readonly lastReady: PlanReadModel | null;
  readonly transition: PlanTransitionState;
  readonly coach: ChatSurfaceState;
  readonly discardConfirmation: boolean;
  readonly revisionComposer: boolean;
  readonly coursePicker: boolean;
  readonly datePicker: boolean;
  readonly settingPending: {
    readonly setting: "auto-apply" | "weekly-review";
    readonly value: boolean;
  } | null;
}

export interface PlanActions {
  open(): void;
  startPlan(): void;
  submitCoach(message: string): Promise<boolean>;
  stopCoach(): void;
  removeQueuedCoachMessage(id: string): void;
  retryQueuedCoachTurn(claimId: string): void;
  answerCoachDecision(decisionId: string, answer: CoachDecisionAnswer): void;
  skipCoachDecision(decisionId: string): void;
  saveFtp(watts: number): void;
  refreshFtp(): void;
  createDraft(): void;
  updateDraft(message: string): void;
  openDiscardConfirmation(): void;
  closeDiscardConfirmation(): void;
  discardDraft(): void;
  openRevisionComposer(): void;
  closeRevisionComposer(): void;
  openCoursePicker(): void;
  closeCoursePicker(): void;
  chooseCourseFile(): void;
  continueWithoutCourse(): void;
  useCourseWithoutElevation(): void;
  removeCourse(): void;
  openDatePicker(): void;
  closeDatePicker(): void;
  recalculateStartDate(startDate: string): void;
  approveDraft(): void;
  openReplacement(): void;
  closeReplacementConfirmation(): void;
  confirmReplacement(): void;
  retryReplacementCleanup(): void;
  verifyReplacementCleanup(): void;
  writeReplacementMirror(): void;
  openReplacementActivePlan(): void;
  reconcilePlan(): void;
  verifyReconciliation(): void;
  openSeason(): void;
  closeSeason(): void;
  openRaceWeek(): void;
  closeRaceWeek(): void;
  openReadiness(): void;
  closeReadiness(): void;
  refreshReadiness(): void;
  openWorkout(workoutId: string): void;
  closeWorkout(): void;
  resolveWorkoutMatch(workoutId: string, activityId: string, decision: "confirm" | "reject"): void;
  resolveWorkoutDrift(workoutId: string, eventId: string, decision: "adopt" | "restore"): void;
  openProposal(proposalId: string): void;
  reviseProposal(proposalId: string, text: string): void;
  approveProposal(proposalId: string, expectedRevision: number): void;
  rejectProposal(proposalId: string): void;
  openHistory(): void;
  closeHistory(): void;
  undoPlanChange(ledgerId: string): void;
  openPlanSettings(): void;
  closePlanSettings(): void;
  setPlanSetting(setting: "auto-apply" | "weekly-review", value: boolean): void;
  openEndConfirmation(): void;
  closeEndConfirmation(): void;
  confirmEndPlan(): void;
  retryPlanCleanup(): void;
  verifyPlanCleanup(): void;
  openRaceOutcome(): void;
  recordRaceOutcome(outcome: "completed" | "not-completed"): void;
  openEndedConversation(): void;
  closeEndedConversation(): void;
  openAttention(attentionId: string): void;
  returnToCoach(): void;
  retry(): void;
}

export interface PlanSlice {
  readonly plan: PlanSurfaceState;
  readonly planActions: PlanActions | null;
  setPlanHydration: (next: PlanHydrationState) => void;
  setPlanTransition: (next: PlanTransitionState) => void;
  setPlanCoach: (next: ChatSurfaceState) => void;
  setPlanDiscardConfirmation: (open: boolean) => void;
  setPlanRevisionComposer: (open: boolean) => void;
  setPlanCoursePicker: (open: boolean) => void;
  setPlanDatePicker: (open: boolean) => void;
  setPlanSettingPending: (next: PlanSurfaceState["settingPending"]) => void;
  bindPlanActions: (actions: PlanActions | null) => void;
}

export const EMPTY_PLAN_SURFACE: PlanSurfaceState = Object.freeze({
  hydration: Object.freeze({ status: "loading" }),
  lastReady: null,
  transition: Object.freeze({ status: "idle" }),
  coach: EMPTY_CHAT_SURFACE,
  discardConfirmation: false,
  revisionComposer: false,
  coursePicker: false,
  datePicker: false,
  settingPending: null,
});

export function planReadModel(plan: PlanSurfaceState): PlanReadModel | null {
  if (plan.hydration.status === "ready" || plan.hydration.status === "stale") {
    return plan.hydration.state;
  }
  return plan.lastReady;
}

export function planAttentionCount(plan: PlanSurfaceState): number {
  return planReadModel(plan)?.attention.count ?? 0;
}

export const createPlanSlice: StateCreator<EnduragentState, [], [], PlanSlice> = (set) => ({
  plan: EMPTY_PLAN_SURFACE,
  planActions: null,
  setPlanHydration(next) {
    set((current) => {
      const lastReady =
        next.status === "ready" || next.status === "stale" ? next.state : current.plan.lastReady;
      const hydration =
        next.status === "failed" && lastReady !== null
          ? ({ status: "stale", state: lastReady, error: next.error } as const)
          : next;
      return { plan: { ...current.plan, hydration, lastReady } };
    });
  },
  setPlanTransition(next) {
    set((current) => ({ plan: { ...current.plan, transition: next } }));
  },
  setPlanCoach(next) {
    set((current) => ({ plan: { ...current.plan, coach: next } }));
  },
  setPlanDiscardConfirmation(open) {
    set((current) => ({ plan: { ...current.plan, discardConfirmation: open } }));
  },
  setPlanRevisionComposer(open) {
    set((current) => ({ plan: { ...current.plan, revisionComposer: open } }));
  },
  setPlanCoursePicker(open) {
    set((current) => ({ plan: { ...current.plan, coursePicker: open } }));
  },
  setPlanDatePicker(open) {
    set((current) => ({ plan: { ...current.plan, datePicker: open } }));
  },
  setPlanSettingPending(next) {
    set((current) => ({ plan: { ...current.plan, settingPending: next } }));
  },
  bindPlanActions(actions) {
    set({ planActions: actions });
  },
});
