import type { ListPlansResult, PlanCreationCardModel } from "@enduragent/coach-contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanController } from "../src/plan/controller";
import { subscribePlanLibraryRefresh } from "../src/plan/library-refresh";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { EMPTY_PLAN_SURFACE, type PlanActions } from "../src/state/plan-slice";
import { useEnduragentStore } from "../src/state/store";
import { PlanLibrary } from "../src/ui/plan/PlanLibrary";
import { PlanView } from "../src/ui/plan/PlanView";
import { planCreationDraft } from "./plan-creation-draft-fixtures";
import { planReadModel } from "./plan-fixtures";

function stubActions(): ChatActions {
  return {
    submit: vi.fn(async () => true),
    chooseAttachments: vi.fn(),
    pasteAttachment: vi.fn(),
    receiveAttachmentAdmissions: vi.fn(),
    saveAttachmentDraftText: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    selectAttachmentWorkout: vi.fn(),
    reviewAttachmentInPlan: vi.fn(),
    continueMessageInPlan: vi.fn(),
    openPlanningRequest: vi.fn(),
    retryPlanningRequest: vi.fn(),
    retryPlanningRequestLoad: vi.fn(),
    clearPlanningRequestFocus: vi.fn(),
    startPlanCreation: vi.fn(),
    buildPlanCreationDraft: vi.fn(),
    answerPlanCreation: vi.fn(),
    pausePlanCreation: vi.fn(),
    continuePlanCreation: vi.fn(),
    editPlanCreation: vi.fn(),
    cancelPlanCreationEdit: vi.fn(),
    openPlanCreationDiscard: vi.fn(),
    cancelPlanCreationDiscard: vi.fn(),
    confirmPlanCreationDiscard: vi.fn(),
    openPlanCreationActivate: vi.fn(),
    cancelPlanCreationActivate: vi.fn(),
    confirmPlanCreationActivate: vi.fn(),
    stop: vi.fn(),
    removeQueued: vi.fn(),
    runQueuedCommand: vi.fn(),
    retryQueuedTurn: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    retryDecision: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
    answerDecision: vi.fn(),
    skipDecision: vi.fn(),
  };
}

function stubPlanActions(): PlanActions {
  return {
    open: vi.fn(),
    startPlan: vi.fn(),
    closeCoach: vi.fn(),
    submitCoach: vi.fn(async () => true),
    stopCoach: vi.fn(),
    removeQueuedCoachMessage: vi.fn(),
    retryQueuedCoachTurn: vi.fn(),
    answerCoachDecision: vi.fn(),
    skipCoachDecision: vi.fn(),
    saveFtp: vi.fn(),
    refreshFtp: vi.fn(),
    backToCoachInterview: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    openDiscardConfirmation: vi.fn(),
    closeDiscardConfirmation: vi.fn(),
    discardDraft: vi.fn(),
    openRevisionComposer: vi.fn(),
    closeRevisionComposer: vi.fn(),
    openCoursePicker: vi.fn(),
    closeCoursePicker: vi.fn(),
    chooseCourseFile: vi.fn(),
    continueWithoutCourse: vi.fn(),
    useCourseWithoutElevation: vi.fn(),
    removeCourse: vi.fn(),
    openDatePicker: vi.fn(),
    closeDatePicker: vi.fn(),
    recalculateStartDate: vi.fn(),
    approveDraft: vi.fn(),
    openReplacement: vi.fn(),
    closeReplacementConfirmation: vi.fn(),
    confirmReplacement: vi.fn(),
    retryReplacementCleanup: vi.fn(),
    verifyReplacementCleanup: vi.fn(),
    writeReplacementMirror: vi.fn(),
    openReplacementActivePlan: vi.fn(),
    reconcilePlan: vi.fn(),
    verifyReconciliation: vi.fn(),
    openSeason: vi.fn(),
    openReadiness: vi.fn(),
    closeReadiness: vi.fn(),
    refreshReadiness: vi.fn(),
    closeSeason: vi.fn(),
    openRaceWeek: vi.fn(),
    closeRaceWeek: vi.fn(),
    openWorkout: vi.fn(),
    closeWorkout: vi.fn(),
    resolveWorkoutMatch: vi.fn(),
    resolveWorkoutDrift: vi.fn(),
    openProposal: vi.fn(),
    closeProposal: vi.fn(),
    reviseProposal: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    openHistory: vi.fn(),
    closeHistory: vi.fn(),
    undoPlanChange: vi.fn(),
    openPlanSettings: vi.fn(),
    closePlanSettings: vi.fn(),
    setPlanSetting: vi.fn(),
    openEndConfirmation: vi.fn(),
    closeEndConfirmation: vi.fn(),
    confirmEndPlan: vi.fn(),
    retryPlanCleanup: vi.fn(),
    verifyPlanCleanup: vi.fn(),
    openRaceOutcome: vi.fn(),
    recordRaceOutcome: vi.fn(),
    openEndedConversation: vi.fn(),
    closeEndedConversation: vi.fn(),
    openAttention: vi.fn(),
    resolvePlanningRequestDate: vi.fn(),
    returnToCoach: vi.fn(),
    retry: vi.fn(),
  };
}

const creation: PlanCreationCardModel = {
  creationId: "creation-library",
  version: 1,
  status: "in-progress",
  readiness: "incomplete",
  draft: null,
  draftStale: false,
  answeredSummaries: [],
  openQuestion: {
    kind: "goal-question",
    step: { current: 1, total: 9 },
    prompt: "What are you training for?",
    candidates: [],
    eventNotListedOption: {
      label: "Event not listed",
      detail: "Add your event.",
      editorLabel: "Event",
      placeholder: "Event name",
      nameLabel: "Name",
      dateLabel: "Date",
    },
    fitnessOption: { label: "General fitness", detail: "Build fitness." },
    authoredOption: {
      label: "Something else",
      detail: "Name an event.",
      editorLabel: "Event",
      placeholder: "Event name",
    },
  },
};
const active: NonNullable<ListPlansResult["active"]> = {
  planId: "active-library",
  name: "Build steady power",
  start: "1998-09-07",
  end: "1998-10-04",
  weeks: 4,
  status: "active",
  closeReason: null,
  closedAt: null,
  activatedAt: "1998-09-07",
  creationId: null,
};
const closed: ListPlansResult["closed"] = [
  {
    ...active,
    planId: "closed-recent",
    name: "Summer fitness",
    status: "closed",
    closedAt: "1998-09-06",
    closeReason: "completed",
  },
  {
    ...active,
    planId: "closed-older",
    name: "Spring fitness",
    status: "closed",
    closedAt: "1998-08-01",
    closeReason: "stopped",
  },
];
const combinations = [false, true].flatMap((hasCreation) =>
  [false, true].flatMap((hasActive) =>
    [false, true].map((hasClosed) => ({ hasCreation, hasActive, hasClosed })),
  ),
);

beforeEach(() => {
  useEnduragentStore.setState({
    chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation },
    chatActions: stubActions(),
    plan: EMPTY_PLAN_SURFACE,
    planActions: null,
    planLibrary: { status: "loading", value: null },
    planLibraryActions: {
      startCreation: vi.fn(),
      continueCreation: vi.fn(),
      changeInChat: vi.fn(),
    },
    planningReadActions: null,
  });
});

describe("Plan library", () => {
  it("shows the stale creation notice on the library", () => {
    const notice =
      "This creation is no longer unfinished. Open the Plan library for its current result.";
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, notice },
      planLibrary: { status: "ready", value: { creation: null, active, closed } },
    });
    render(<PlanView />);
    expect(screen.getByText(notice, { exact: true })).toBeVisible();
    expect(screen.getByRole("region", { name: "Plan library" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue in Chat" })).toBeNull();
  });

  it.each(combinations)(
    "renders creation=$hasCreation active=$hasActive closed=$hasClosed in library order",
    ({ hasCreation, hasActive, hasClosed }) => {
      const library: ListPlansResult = {
        creation: hasCreation ? creation : null,
        active: hasActive ? active : null,
        closed: hasClosed ? closed : [],
      };
      useEnduragentStore.setState({ planLibrary: { status: "ready", value: library } });
      render(<PlanView />);
      const section = screen.getByRole("region", { name: "Plan library" });
      expect(
        within(section)
          .getAllByRole("heading")
          .map((heading) => heading.textContent),
      ).toEqual([
        ...(hasCreation ? ["New Plan"] : []),
        hasActive ? "Build steady power" : "No active Plan",
        ...(hasClosed ? ["Summer fitness", "Spring fitness"] : []),
      ]);
      if (hasCreation) {
        const card = within(section).getByRole("region", { name: "Plan creation" });
        expect(within(card).getByText("In progress")).toBeVisible();
        expect(
          within(card).getByText(
            `0 of 9 answered. ${hasActive ? "Build steady power keeps running." : "No Plan is active."}`,
          ),
        ).toBeVisible();
        expect(
          within(card)
            .getAllByRole("button")
            .map((button) => button.textContent),
        ).toEqual(["Discard", "Continue in Chat"]);
        expect(screen.queryByRole("button", { name: /^Start a (new )?Plan$/ })).toBeNull();
      } else {
        const start = screen.getByRole("button", {
          name: hasActive ? "Start a new Plan" : "Start a Plan",
        });
        fireEvent.click(start);
        expect(
          useEnduragentStore.getState().planLibraryActions?.startCreation,
        ).toHaveBeenCalledOnce();
      }
      if (hasActive) {
        const card = within(section).getByRole("region", { name: "Active Plan" });
        expect(within(card).getByText("7 Sept 1998 to 4 Oct 1998 · 4 weeks")).toBeVisible();
        expect(within(card).getByText("Active", { exact: true })).toBeVisible();
        expect(
          within(card)
            .getAllByRole("button")
            .map((button) => button.textContent),
        ).toEqual(["Read Plan details", "Change in Chat"]);
      } else {
        expect(within(section).getByText("Create a Plan when you are ready.")).toBeVisible();
      }
      if (hasClosed) {
        const cards = within(section).getAllByRole("region", { name: "Closed Plan" });
        expect(
          within(cards[0]!).getByText("7 Sept 1998 to 4 Oct 1998 · 4 weeks · Completed"),
        ).toBeVisible();
        expect(
          within(cards[1]!).getByText("7 Sept 1998 to 4 Oct 1998 · 4 weeks · Stopped"),
        ).toBeVisible();
        for (const card of cards) expect(within(card).queryByRole("button")).toBeNull();
      }
      expect(screen.queryByRole("button", { name: "Read final details" })).toBeNull();
    },
  );

  it("dispatches each library action with the current creation", () => {
    const readDetails = vi.fn();
    render(<PlanLibrary library={{ creation, active, closed }} readDetails={readDetails} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      useEnduragentStore.getState().chatActions?.openPlanCreationDiscard,
    ).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Continue in Chat" }));
    expect(useEnduragentStore.getState().planLibraryActions?.continueCreation).toHaveBeenCalledWith(
      creation,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change in Chat" }));
    expect(useEnduragentStore.getState().planLibraryActions?.changeInChat).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Read Plan details" }));
    expect(readDetails).toHaveBeenCalledOnce();
  });

  it("shows Paused only for the matching creation and Draft takes precedence", () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation, planCreationPaused: true },
    });
    const view = render(
      <PlanLibrary library={{ creation, active: null, closed: [] }} readDetails={vi.fn()} />,
    );
    expect(screen.getByText("Paused")).toBeVisible();
    view.rerender(
      <PlanLibrary
        library={{
          creation: { ...creation, draft: planCreationDraft() },
          active: null,
          closed: [],
        }}
        readDetails={vi.fn()}
      />,
    );
    expect(screen.getByText("Draft")).toBeVisible();
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("preserves readable cards with an explicit retry on failure", () => {
    const refresh = vi.fn();
    const library: ListPlansResult = { creation: null, active, closed };
    useEnduragentStore.setState({
      planLibrary: { status: "ready", value: library },
      planningReadActions: {
        refresh,
        openFromChat: vi.fn(),
        backToChat: vi.fn(),
        returnToChatRequest: vi.fn(),
      },
    });
    render(<PlanView />);
    expect(refresh).not.toHaveBeenCalled();
    act(() =>
      useEnduragentStore.setState({ planLibrary: { status: "unavailable", value: library } }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Plan library could not load. Try again.");
    expect(screen.getByRole("heading", { name: "Summer fitness" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["navigation", "relaunch"] as const)(
    "lists once on %s before a lazy mount, then once per refresh and reopen",
    async (entry) => {
      const store = useEnduragentStore;
      store.setState({ activeView: entry === "relaunch" ? "plan" : "chat" });
      const listPlans = vi.fn(
        async (): Promise<ListPlansResult> => ({
          creation,
          active,
          closed,
        }),
      );
      const controller = createPlanController({
        listPlans,
        read: async () => ({
          schemaVersion: 1,
          status: "no-plan",
          asOfDateKey: 19980907,
          plan: null,
        }),
        renderLibrary: (next) => store.getState().setPlanLibrary(next),
        render: (next) => store.getState().setPlanSurface(next),
        navigate: (view) => store.getState().setActiveView(view),
        focus: (target, returnToChat) => store.getState().setPlanFocus(target, returnToChat),
      });
      store.getState().bindPlanningReadActions({
        refresh: () => void controller.refresh(),
        openFromChat: controller.openFromChat,
        backToChat: controller.backToChat,
        returnToChatRequest: vi.fn(),
      });
      const unsubscribe = subscribePlanLibraryRefresh(controller);
      let mountView!: (module: { default: typeof PlanView }) => void;
      const viewModule = new Promise<{ default: typeof PlanView }>((resolve) => {
        mountView = resolve;
      });
      const LazyPlanView = lazy(() => viewModule);
      try {
        if (entry === "relaunch") await controller.start();
        else {
          store.getState().setActiveView("plan");
          await vi.waitFor(() => expect(store.getState().planLibrary.status).toBe("ready"));
        }
        expect(listPlans).toHaveBeenCalledOnce();
        const view = render(
          <Suspense fallback={<div>Loading Plan view</div>}>
            <LazyPlanView />
          </Suspense>,
        );
        expect(screen.getByText("Loading Plan view")).toBeVisible();
        await act(async () => mountView({ default: PlanView }));
        expect(screen.getByRole("region", { name: "Plan library" })).toBeVisible();
        expect(listPlans).toHaveBeenCalledOnce();
        await act(async () =>
          store.setState({
            chat: {
              ...store.getState().chat,
              planCreation: structuredClone(creation),
              planCreationLoaded: true,
            },
          }),
        );
        expect(listPlans).toHaveBeenCalledOnce();

        await act(async () => store.getState().planningReadActions?.refresh());
        expect(listPlans).toHaveBeenCalledTimes(2);

        view.unmount();
        store.getState().setActiveView("chat");
        await act(async () => store.getState().setActiveView("plan"));
        render(<PlanView />);
        expect(listPlans).toHaveBeenCalledTimes(3);
      } finally {
        unsubscribe();
        controller.dispose();
      }
    },
  );
});

describe("Plan library refresh subscription", () => {
  function watchRefresh() {
    const refresh = vi.fn(async () => {});
    const unsubscribe = subscribePlanLibraryRefresh({
      refresh,
      start: vi.fn(async () => {}),
      openFromChat: vi.fn(),
      backToChat: vi.fn(),
      dispose: vi.fn(),
    });
    return { refresh, unsubscribe };
  }

  it("does not reread when Chat hydrates the creation already in the library", () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: null },
      planLibrary: { status: "ready", value: { creation, active, closed } },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        chat: {
          ...EMPTY_CHAT_SURFACE,
          planCreation: structuredClone(creation),
          planCreationLoaded: true,
        },
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("ignores cloned creation objects with the same id and version", () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation, planCreationLoaded: true },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        chat: { ...useEnduragentStore.getState().chat, planCreation: structuredClone(creation) },
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { ...creation, version: creation.version + 1 },
    { ...creation, creationId: "replacement-creation" },
  ])("refreshes once when creation identity changes to $creationId version $version", (next) => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation, planCreationLoaded: true },
      planLibrary: { status: "ready", value: { creation, active, closed } },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        chat: { ...useEnduragentStore.getState().chat, planCreation: next },
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      unsubscribe();
    }
  });

  it("ignores active Plan hydration and clones but refreshes once for a different Plan id", () => {
    const model = planReadModel({ lifecycle: "active", planId: active.planId });
    useEnduragentStore.setState({
      planLibrary: { status: "ready", value: { creation, active, closed } },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        plan: {
          ...EMPTY_PLAN_SURFACE,
          hydration: { status: "ready", state: model },
          lastReady: model,
        },
      });
      useEnduragentStore.setState({ plan: structuredClone(useEnduragentStore.getState().plan) });
      expect(refresh).not.toHaveBeenCalled();
      const next = { ...model, planId: "replacement-active-plan" };
      useEnduragentStore.setState({
        plan: {
          ...EMPTY_PLAN_SURFACE,
          hydration: { status: "ready", state: next },
          lastReady: next,
        },
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      unsubscribe();
    }
  });

  it("joins the pending startup read when Chat hydrates instead of queuing another read", async () => {
    const store = useEnduragentStore;
    store.setState({
      activeView: "plan",
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: null },
    });
    let resolveResult: (value: ListPlansResult) => void = () => {};
    const result = {
      promise: new Promise<ListPlansResult>((resolve) => {
        resolveResult = resolve;
      }),
      resolve: (value: ListPlansResult) => resolveResult(value),
    };
    const listPlans = vi.fn(() => result.promise);
    const controller = createPlanController({
      listPlans,
      read: async () => ({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 19980907,
        plan: null,
      }),
      renderLibrary: (next) => store.getState().setPlanLibrary(next),
      render: (next) => store.getState().setPlanSurface(next),
      navigate: (view) => store.getState().setActiveView(view),
      focus: (target, returnToChat) => store.getState().setPlanFocus(target, returnToChat),
    });
    const refresh = vi.spyOn(controller, "refresh");
    const unsubscribe = subscribePlanLibraryRefresh(controller);
    try {
      const started = controller.start();
      store.setState({
        chat: {
          ...EMPTY_CHAT_SURFACE,
          planCreation: structuredClone(creation),
          planCreationLoaded: true,
        },
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
      result.resolve({ creation, active, closed });
      await started;
      await Promise.all(refresh.mock.results.map((call) => call.value));
      expect(listPlans).toHaveBeenCalledOnce();
      expect(store.getState().planLibrary).toEqual({
        status: "ready",
        value: { creation, active, closed },
      });
    } finally {
      unsubscribe();
      controller.dispose();
    }
  });
});

describe("Plan creation title", () => {
  it.each(["manual", "candidate", "fitness"] as const)(
    "formats the %s goal from its typed answer",
    (kind) => {
      const candidate = {
        candidateId: "01J00000000000000000000000",
        name: "Autumn Hills Ride",
        date: "1998-10-04",
        sourceLabel: "Calendar",
      };
      const question = creation.openQuestion;
      if (question?.kind !== "goal-question") throw new Error("Goal question required");
      const answered: PlanCreationCardModel = {
        ...creation,
        answeredSummaries: [
          {
            answerKey: "goal",
            title: "Goal",
            detail: "Autumn Hills Ride · 1998-10-04",
            source: { kind: "athlete" },
            question: { ...question, candidates: [candidate] },
            answer: {
              kind: "goal",
              goal:
                kind === "fitness"
                  ? { kind: "fitness", outcome: "Build lasting fitness" }
                  : kind === "manual"
                    ? { kind: "event-manual", name: candidate.name, date: candidate.date }
                    : { kind: "event-candidate", candidateId: candidate.candidateId },
            },
          },
        ],
      };
      render(
        <PlanLibrary
          library={{ creation: answered, active: null, closed: [] }}
          readDetails={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("heading", {
          name: kind === "fitness" ? "Build lasting fitness" : "Autumn Hills Ride · 4 Oct 1998",
        }),
      ).toBeVisible();
      expect(screen.getByText("1 of 9 answered. No Plan is active.")).toBeVisible();
    },
  );
});

it("keeps Plan history below the library while a creation occupies the header", () => {
  const planActions = stubPlanActions();
  const model = planReadModel({
    lifecycle: "active",
    scenarioId: "PL-S004",
    projection: "active",
    planId: active.planId,
    data: {
      plan: {
        id: active.planId,
        name: active.name,
        primaryGoal: "Build steady power",
        startDate: active.start,
        targetDate: active.end,
        kind: "full-plan",
        totalWeeks: active.weeks,
        weekStartDay: 1,
        workoutCount: 0,
        plannedDurationS: 0,
      },
      today: "1998-09-07",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [],
    },
  });
  useEnduragentStore.setState({
    plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state: model }, lastReady: model },
    planActions,
    planLibrary: { status: "ready", value: { creation, active, closed: [] } },
  });
  render(<PlanView />);
  const library = screen.getByRole("region", { name: "Plan library" });
  const history = screen.getByRole("button", { name: "Plan history" });
  expect(within(library).queryByRole("button", { name: "Plan history" })).toBeNull();
  expect(library.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Start a (new )?Plan$/ })).toBeNull();
  fireEvent.click(history);
  expect(planActions.openHistory).toHaveBeenCalledOnce();
});
