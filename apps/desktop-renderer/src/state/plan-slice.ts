import type { PlanNavigationTarget, PlanningReadModel } from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { EnduragentState } from "./store.js";

export type PlanSurfaceState =
  | { readonly status: "loading"; readonly value: null }
  | { readonly status: "ready"; readonly value: PlanningReadModel }
  | { readonly status: "unavailable"; readonly value: PlanningReadModel | null };

export interface PlanActions {
  refresh(): void;
  openFromChat(target: PlanNavigationTarget): void;
  backToChat(): void;
}

export interface PlanSlice {
  readonly planSurface: PlanSurfaceState;
  readonly planFocus: PlanNavigationTarget | null;
  readonly planReturnToChat: boolean;
  readonly planActions: PlanActions | null;
  setPlanSurface: (value: PlanSurfaceState) => void;
  setPlanFocus: (value: PlanNavigationTarget | null, returnToChat: boolean) => void;
  bindPlanActions: (actions: PlanActions | null) => void;
}

export const createPlanSlice: StateCreator<EnduragentState, [], [], PlanSlice> = (set) => ({
  planSurface: { status: "loading", value: null },
  planFocus: null,
  planReturnToChat: false,
  planActions: null,
  setPlanSurface(value) {
    set({ planSurface: value });
  },
  setPlanFocus(value, returnToChat) {
    set({ planFocus: value, planReturnToChat: returnToChat });
  },
  bindPlanActions(actions) {
    set({ planActions: actions });
  },
});
