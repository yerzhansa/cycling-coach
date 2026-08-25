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
  createDraft(): void;
  updateDraft(message: string): void;
  openDiscardConfirmation(): void;
  closeDiscardConfirmation(): void;
  discardDraft(): void;
  openRevisionComposer(): void;
  closeRevisionComposer(): void;
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
  bindPlanActions: (actions: PlanActions | null) => void;
}

export const EMPTY_PLAN_SURFACE: PlanSurfaceState = Object.freeze({
  hydration: Object.freeze({ status: "loading" }),
  lastReady: null,
  transition: Object.freeze({ status: "idle" }),
  coach: EMPTY_CHAT_SURFACE,
  discardConfirmation: false,
  revisionComposer: false,
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
  bindPlanActions(actions) {
    set({ planActions: actions });
  },
});
