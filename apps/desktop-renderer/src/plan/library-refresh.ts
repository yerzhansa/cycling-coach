import { planReadModel } from "../state/plan-slice";
import { useEnduragentStore } from "../state/store";
import type { PlanController } from "./controller";

export function subscribePlanLibraryRefresh(controller: PlanController): () => void {
  return useEnduragentStore.subscribe((state, previousState) => {
    const creation = state.chat.planCreation;
    const previousCreation = previousState.chat.planCreation;
    const creationChanged =
      creation?.creationId !== previousCreation?.creationId ||
      creation?.version !== previousCreation?.version;
    const plan = planReadModel(state.plan);
    const previousPlan = planReadModel(previousState.plan);
    const activePlanId = plan?.lifecycle === "active" ? plan.planId : null;
    const previousActivePlanId = previousPlan?.lifecycle === "active" ? previousPlan.planId : null;
    const library = state.planLibrary.value;
    const creationNeedsRefresh =
      creationChanged &&
      (library === null ||
        creation?.creationId !== library.creation?.creationId ||
        creation?.version !== library.creation?.version);
    const activePlanNeedsRefresh =
      activePlanId !== previousActivePlanId && activePlanId !== (library?.active?.planId ?? null);
    const opened = state.activeView === "plan" && previousState.activeView !== "plan";
    if (opened || creationNeedsRefresh || activePlanNeedsRefresh)
      void controller.refresh(
        opened ||
          (creationNeedsRefresh && previousState.chat.planCreationLoaded) ||
          (activePlanNeedsRefresh && previousPlan !== null),
      );
  });
}
