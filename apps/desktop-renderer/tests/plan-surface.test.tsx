import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanActiveProjectionDataSchema } from "@enduragent/coach-contract";
import { EMPTY_PLAN_SURFACE, type PlanActions } from "../src/state/plan-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { PlanView } from "../src/ui/plan/PlanView.js";
import { PLAN_ERROR, planCoachData, planReadModel } from "./plan-fixtures.js";

function actions(): PlanActions {
  return {
    open: vi.fn(),
    startPlan: vi.fn(),
    submitCoach: vi.fn(async () => true),
    stopCoach: vi.fn(),
    removeQueuedCoachMessage: vi.fn(),
    retryQueuedCoachTurn: vi.fn(),
    answerCoachDecision: vi.fn(),
    skipCoachDecision: vi.fn(),
    saveFtp: vi.fn(),
    refreshFtp: vi.fn(),
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
    reconcilePlan: vi.fn(),
    verifyReconciliation: vi.fn(),
    openWorkout: vi.fn(),
    closeWorkout: vi.fn(),
    resolveWorkoutMatch: vi.fn(),
    resolveWorkoutDrift: vi.fn(),
    openProposal: vi.fn(),
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
    openAttention: vi.fn(),
    returnToCoach: vi.fn(),
    retry: vi.fn(),
  };
}

beforeEach(() => {
  useEnduragentStore.setState({ plan: EMPTY_PLAN_SURFACE, planActions: actions() });
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  useEnduragentStore.setState({ plan: EMPTY_PLAN_SURFACE, planActions: null });
});

describe("Plan surface", () => {
  it("renders explicit loading, failed, and compatibility states", async () => {
    const user = userEvent.setup();
    render(<PlanView />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your Plan");

    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "failed", error: PLAN_ERROR });
    });
    expect(screen.getByRole("heading", { name: "Plan could not load" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(useEnduragentStore.getState().planActions?.retry).toHaveBeenCalledOnce();

    act(() => {
      useEnduragentStore.getState().setPlanHydration({
        status: "unsupported-capability",
        capability: "planning",
      });
    });
    expect(screen.getByRole("heading", { name: "Plan is not available yet" })).toBeInTheDocument();
    expect(screen.getByText(/Update Enduragent/u)).toBeInTheDocument();
  });

  it("renders the accepted no-Plan hierarchy and starts PL-T01 from the keyboard", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: planReadModel() },
        lastReady: planReadModel(),
      },
      planActions,
    });
    render(<PlanView />);

    expect(
      screen.getByRole("heading", { name: "Train toward one clear goal" }),
    ).toBeInTheDocument();
    expect(screen.getByText("What the draft needs")).toBeInTheDocument();
    expect(screen.getByText("Goal event + Race Course")).toBeInTheDocument();
    expect(screen.getByText("Current training")).toBeInTheDocument();
    expect(screen.getByText("FTP")).toBeInTheDocument();
    expect(screen.getAllByText(/GPX\/FIT/u)).toHaveLength(2);

    const start = screen.getByRole("button", { name: "Build a plan with coach" });
    start.focus();
    await user.keyboard("{Enter}");
    expect(planActions.startPlan).toHaveBeenCalledOnce();
  });

  it("keeps the last ready no-Plan screen visible when hydration becomes stale", () => {
    const state = planReadModel();
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
    });
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "failed", error: PLAN_ERROR });
    });
    render(<PlanView />);

    expect(screen.getByText(PLAN_ERROR.message)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Train toward one clear goal" }),
    ).toBeInTheDocument();
  });

  it("renders the server attention projection without deriving a count", () => {
    const state = planReadModel({
      attentionCount: 2,
      lifecycle: "active",
      planId: "plan-1",
      projection: "attention",
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
    });
    render(<PlanView />);

    expect(screen.getByText("2 items need your decision.")).toBeInTheDocument();
    expect(screen.getByText("Decision 1")).toBeInTheDocument();
    expect(screen.getByText("Decision 2")).toBeInTheDocument();
  });

  it("keeps the Coach interview inside Plan and offers Draft creation when ready", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const state = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S016",
      projection: "coach",
      data: planCoachData({ ready: true }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByRole("log", { name: "Coach conversation" })).toHaveTextContent(
      "What event are you training toward",
    );
    expect(screen.getByRole("heading", { name: "Ready to create Draft" })).toBeInTheDocument();
    const composer = screen.getByRole("combobox", { name: "Reply to your Plan coach" });
    await user.type(composer, "Four days each week.{Enter}");
    expect(planActions.submitCoach).toHaveBeenCalledWith("Four days each week.");
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(planActions.createDraft).toHaveBeenCalledOnce();
  });

  it("keeps Race Course selection and recovery inside the Plan surface", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData({
        course: {
          status: "undecided",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: initial },
        lastReady: initial,
      },
      planActions,
    });
    render(<PlanView />);

    await user.click(screen.getByRole("button", { name: "Attach GPX/FIT" }));
    expect(planActions.openCoursePicker).toHaveBeenCalledOnce();
    act(() => useEnduragentStore.getState().setPlanCoursePicker(true));
    expect(screen.getByRole("heading", { name: "Add Race Course" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Choose file" }));
    expect(planActions.chooseCourseFile).toHaveBeenCalledOnce();

    const missingElevation = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S067",
      projection: "coach",
      data: planCoachData({
        course: {
          status: "missing-elevation",
          accepted: null,
          candidate: {
            fileName: "route-only.gpx",
            format: "gpx",
            pointCount: 42,
            distanceM: 120_000,
            elevationGainM: null,
            elevationStatus: "unavailable",
          },
          fileName: null,
          detail: null,
        },
      }),
    });
    act(() => {
      useEnduragentStore.getState().setPlanCoursePicker(false);
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: missingElevation });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Route found, elevation missing");
    await user.click(screen.getByRole("button", { name: "Use route only" }));
    expect(planActions.useCourseWithoutElevation).toHaveBeenCalledOnce();
  });

  it("resolves FTP with one compact whole-watts control and an Intervals refresh", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const state = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S003",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "required",
          manual: null,
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: null,
          usedWatts: null,
          conflict: false,
          error: null,
        },
      }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
      planActions,
    });
    render(<PlanView />);

    expect(
      screen.getByRole("heading", { name: "FTP needed before we build your cycling block" }),
    ).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "FTP in whole watts" });
    expect(input).toHaveAttribute("maxlength", "4");
    expect(input).toHaveClass("w-28");
    await user.type(input, "282");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(planActions.saveFtp).toHaveBeenCalledWith(282);
    await user.click(screen.getByRole("button", { name: "Refresh Intervals" }));
    expect(planActions.refreshFtp).toHaveBeenCalledOnce();
  });

  it("shows the selected FTP source and keeps conflicting values visible", () => {
    const state = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S060",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "conflict",
          manual: { watts: 282, refreshedAtMs: 1 },
          intervalsFtp: { watts: 278, refreshedAtMs: 2 },
          intervalsEftp: { watts: 280, refreshedAtMs: 3 },
          usedSource: "manual",
          usedWatts: 282,
          conflict: true,
          error: null,
        },
      }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
    });
    render(<PlanView />);

    expect(screen.getByText(/282 W.*Used for this Draft/u)).toBeInTheDocument();
    expect(screen.getByText(/278 W/u)).toBeInTheDocument();
    expect(screen.getByText(/280 W/u)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("highest-precedence value");
  });

  it("keeps a failed Intervals refresh recoverable without hiding manual entry", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const error = { code: "provider-failed" as const, message: "Refresh failed", retryable: true };
    const state = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S059",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "refresh-failed",
          manual: null,
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: null,
          usedWatts: null,
          conflict: false,
          error,
        },
      }),
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
        transition: {
          status: "failed",
          commandId: "command-1",
          transitionId: "PL-T04",
          error,
        },
      },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByRole("textbox", { name: "FTP in whole watts" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Refresh failed");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(planActions.refreshFtp).toHaveBeenCalledOnce();
  });

  it("confirms Draft discard with Cancel focused before the destructive action", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const draft = {
      id: "00000000000000000000000002",
      planId: "00000000000000000000000003",
      revision: 1,
      status: "ready" as const,
      snapshot: { completeWeeks: 12 },
    };
    const state = planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S002",
      projection: "draft",
      planId: draft.planId,
      revision: 1,
      data: planCoachData({ draft }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
      planActions,
    });
    render(<PlanView />);
    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(planActions.openDiscardConfirmation).toHaveBeenCalledOnce();
    act(() => useEnduragentStore.getState().setPlanDiscardConfirmation(true));
    expect(screen.getByRole("heading", { name: "Discard this Draft?" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Discard Draft" }));
    expect(planActions.discardDraft).toHaveBeenCalledOnce();
  });

  it("uses a compact keyboard date picker and confirms a shorter valid block", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const draft = {
      id: "00000000000000000000000002",
      planId: "00000000000000000000000003",
      revision: 1,
      status: "ready" as const,
      snapshot: {},
    };
    const plan = {
      id: draft.planId,
      name: "Gran Fondo Plan",
      primaryGoal: "Finish in the front half",
      startDate: "2026-07-13",
      targetDate: "2026-10-04",
      kind: "full-plan" as const,
      totalWeeks: 12,
      weekStartDay: 1,
      workoutCount: 58,
      plannedDurationS: 309_600,
    };
    const startDate = {
      status: "ready" as const,
      selectedDate: "2026-07-13",
      today: "2026-07-13",
      targetDate: "2026-10-04",
      kind: "full-plan" as const,
      inclusiveDays: 84,
      totalWeeks: 12,
      raceWeekday: 0,
      raceDayOfPlanWeek: 7,
      error: null,
    };
    const state = planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S002",
      projection: "draft",
      planId: draft.planId,
      revision: 1,
      data: planCoachData({ draft, plan, startDate }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByText("58 workouts · 86 h · 12 weeks")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(planActions.openDatePicker).toHaveBeenCalledOnce();
    act(() => useEnduragentStore.getState().setPlanDatePicker(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    const day = document.querySelector<HTMLButtonElement>('[data-plan-date="2026-07-20"]');
    expect(day).not.toBeNull();
    expect(day).toHaveClass("size-10");
    day?.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.querySelector('[data-plan-date="2026-07-21"]')).toHaveFocus();
    await user.click(day!);
    expect(
      screen.getByRole("heading", { name: "Short race-preparation block" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use short block" }));
    expect(planActions.recalculateStartDate).toHaveBeenCalledWith("2026-07-20");
  });

  it("returns a revised Draft to review and exposes the approval command", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const draft = {
      id: "00000000000000000000000002",
      planId: "00000000000000000000000003",
      revision: 2,
      status: "ready" as const,
      snapshot: {},
    };
    const state = planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S031",
      projection: "draft",
      planId: draft.planId,
      revision: draft.revision,
      data: planCoachData({ draft }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByRole("status")).toHaveTextContent("Draft updated");
    await user.click(screen.getByRole("button", { name: "Approve Plan" }));
    expect(planActions.approveDraft).toHaveBeenCalledOnce();
  });

  it("keeps a failed start-date recalculation visible with both recovery choices", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const error = {
      code: "provider-failed" as const,
      message: "The Plan could not be recalculated. Your current Draft is safe.",
      retryable: true,
    };
    const draft = {
      id: "00000000000000000000000002",
      planId: "00000000000000000000000003",
      revision: 2,
      status: "ready" as const,
      snapshot: {},
    };
    const state = planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S048",
      projection: "draft",
      planId: draft.planId,
      revision: draft.revision,
      data: planCoachData({
        draft,
        startDate: {
          status: "failed",
          selectedDate: "2026-07-20",
          today: "2026-07-13",
          targetDate: "2026-10-04",
          kind: "short-race-preparation",
          inclusiveDays: 77,
          totalWeeks: 11,
          raceWeekday: 0,
          raceDayOfPlanWeek: 7,
          error,
        },
      }),
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
        transition: {
          status: "failed",
          commandId: "command-date",
          transitionId: "PL-T08",
          error,
        },
      },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByRole("alert")).toHaveTextContent("current Draft is safe");
    await user.click(screen.getByRole("button", { name: "Choose another date" }));
    expect(planActions.openDatePicker).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(planActions.retry).toHaveBeenCalledOnce();
  });

  it("keeps reconciliation failures inline on the active Plan with retry and verify actions", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S039",
      projection: "active",
      planId: "00000000000000000000000003",
      attentionCount: 1,
      reconciliation: {
        status: "failed",
        created: 1,
        pending: 0,
        failed: 1,
        total: 2,
        currentThrough: null,
        error: {
          code: "provider-failed",
          message: "Some workouts could not be updated in Intervals.",
          retryable: true,
        },
      },
      data: {
        plan: {
          id: "00000000000000000000000003",
          name: "Gran Fondo Almaty",
          primaryGoal: "Finish in the front half",
          startDate: "2026-07-13",
          targetDate: "2026-10-04",
          kind: "full-plan",
          totalWeeks: 12,
          weekStartDay: 1,
          workoutCount: 20,
          plannedDurationS: 72_000,
        },
        today: "2026-08-18",
        weekIndex: 6,
        todayWorkout: {
          id: "00000000000000000000000004",
          date: "2026-08-18",
          sport: "cycling",
          name: "Recovery spin",
          durationS: 2_700,
        },
        workouts: [],
      },
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
      planActions,
    });

    render(<PlanView />);

    expect(screen.getByRole("heading", { name: "Plan active · week 6 of 12" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today · Recovery spin" })).toBeInTheDocument();
    expect(screen.getByText("Created 1 · Pending 0 · Failed 1 · Total 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Verify again" }));
    expect(planActions.reconcilePlan).toHaveBeenCalledOnce();
    expect(planActions.verifyReconciliation).toHaveBeenCalledOnce();
  });

  it("confirms End Plan with Cancel focused and keeps failed cleanup recoverable", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const plan = {
      id: planId,
      name: "Gran Fondo Almaty",
      primaryGoal: "Finish in the front half",
      startDate: "2026-07-13",
      targetDate: "2026-10-04",
      kind: "full-plan" as const,
      totalWeeks: 12,
      weekStartDay: 1,
      workoutCount: 20,
      plannedDurationS: 72_000,
    };
    const confirmation = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S051",
      projection: "active",
      planId,
      data: {
        plan,
        today: "2026-08-26",
        weekIndex: 7,
        todayWorkout: null,
        workouts: [],
      },
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: confirmation },
        lastReady: confirmation,
      },
      planActions,
    });
    render(<PlanView />);

    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.click(within(dialog).getByRole("button", { name: "End Plan" }));
    expect(planActions.confirmEndPlan).toHaveBeenCalledOnce();

    const failed = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S053",
      projection: "ended",
      planId,
      attentionCount: 1,
      reconciliation: {
        status: "failed",
        created: 0,
        pending: 0,
        failed: 1,
        total: 1,
        currentThrough: null,
        error: { code: "provider-failed", message: "Cleanup failed.", retryable: true },
      },
      data: {
        plan,
        endedAtMs: 20,
        cleanupItems: [
          {
            id: "00000000000000000000000004",
            date: "2026-08-27",
            externalId: "cycling-coach:plan:workout",
            status: "failed",
            errorCode: "calendar-delete-failed",
          },
        ],
      },
    });
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: failed });
    });
    expect(
      screen.getByRole("heading", { name: "Calendar cleanup needs attention" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue anyway/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify again" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(planActions.verifyPlanCleanup).toHaveBeenCalledOnce();
    expect(planActions.retryPlanCleanup).toHaveBeenCalledOnce();
  });

  it("highlights WorkoutMatch decisions and keeps drawer actions visible", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const workoutId = "00000000000000000000000004";
    const activityId = "a".repeat(64);
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S021",
      projection: "active",
      planId: "00000000000000000000000003",
      attentionCount: 1,
      data: {
        plan: {
          id: "00000000000000000000000003",
          name: "Gran Fondo Almaty",
          primaryGoal: "Finish in the front half",
          startDate: "2026-07-13",
          targetDate: "2026-10-04",
          kind: "full-plan",
          totalWeeks: 12,
          weekStartDay: 1,
          workoutCount: 20,
          plannedDurationS: 72_000,
        },
        today: "2026-08-18",
        weekIndex: 6,
        todayWorkout: null,
        workouts: [
          {
            id: workoutId,
            date: "2026-08-23",
            sport: "cycling",
            name: "Suggested endurance",
            durationS: 1_800,
            match: {
              kind: "planned",
              status: "decision-needed",
              activityId,
              matchId: "00000000000000000000000005",
              actualDate: "2026-08-23",
              actualDurationS: 1_900,
              requiresConfirmation: true,
            },
          },
        ],
        matchSync: { lastSuccessfulSyncAtMs: 1_787_477_200_000, awaitingSync: false },
        selectedWorkoutId: workoutId,
      },
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getAllByText("Decision needed").length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toHaveTextContent("Suggested endurance");
    await user.click(screen.getByRole("button", { name: "Confirm match" }));
    expect(planActions.resolveWorkoutMatch).toHaveBeenCalledWith(workoutId, activityId, "confirm");
    await user.click(screen.getByRole("button", { name: "Not this activity" }));
    expect(planActions.resolveWorkoutMatch).toHaveBeenCalledWith(workoutId, activityId, "reject");
  });

  it("renders structured Proposal diffs, read-only evidence, and explicit decisions", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const workoutId = "00000000000000000000000004";
    const proposalId = "00000000000000000000000005";
    const state = {
      ...planReadModel({
        lifecycle: "active",
        scenarioId: "PL-S007",
        projection: "active",
        planId,
        attentionCount: 1,
        data: {
          plan: {
            id: planId,
            name: "Gran Fondo Almaty",
            primaryGoal: "Finish in the front half",
            startDate: "2026-07-13",
            targetDate: "2026-10-04",
            kind: "full-plan",
            totalWeeks: 12,
            weekStartDay: 1,
            workoutCount: 20,
            plannedDurationS: 72_000,
          },
          today: "2026-08-18",
          weekIndex: 6,
          todayWorkout: null,
          workouts: [
            {
              id: workoutId,
              date: "2026-08-23",
              sport: "cycling",
              name: "Endurance",
              durationS: 5_400,
            },
          ],
          selectedWorkoutId: null,
          selectedProposalId: proposalId,
          proposals: [
            {
              id: proposalId,
              revision: 1,
              title: "Sunday recovery",
              rationale: "Saturday fatigue is 12 above your normal range.",
              confidence: "High",
              targetWorkoutId: workoutId,
              affectedDate: "2026-08-23",
              stale: false,
              diff: [
                { field: "duration", label: "Duration", before: "1:30", after: "0:30" },
                { field: "workout", label: "Workout", before: "Endurance", after: "Recovery" },
                { field: "week-load", label: "Week load", before: "420", after: "360" },
              ],
              premises: [
                {
                  id: "00000000000000000000000006",
                  sourceType: "activity",
                  sourceId: "ride-21-aug",
                  sourceLabel: "Saturday ride · 21 Aug · Assioma pedals",
                  sourceDate: "2026-08-21",
                  confidence: "High",
                  snapshotJson: '{"loadAboveNormal":12}',
                },
              ],
              error: null,
            },
          ],
        },
      }),
      transitions: ["PL-T17", "PL-T18", "PL-T19", "PL-T20"].map((transitionId) => ({
        transitionId: transitionId as "PL-T17" | "PL-T18" | "PL-T19" | "PL-T20",
        status: "available" as const,
        reason: null,
      })),
    };
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
      planActions,
    });
    render(<PlanView />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Duration1:30 → 0:30");
    expect(dialog).toHaveTextContent("WorkoutEndurance → Recovery");
    expect(dialog).toHaveTextContent("Week load420 → 360");
    const evidence = screen.getByRole("button", { name: "View evidence" });
    await user.click(evidence);
    expect(screen.getByRole("heading", { name: "Where this came from" })).toBeInTheDocument();
    expect(screen.getByText("Saturday ride · 21 Aug · Assioma pedals")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "View evidence" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(planActions.rejectProposal).toHaveBeenCalledWith(proposalId);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(planActions.approveProposal).toHaveBeenCalledWith(proposalId, 1);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Your change"), "Keep 45 minutes and make it recovery.");
    await user.click(screen.getByRole("button", { name: "Update Proposal" }));
    expect(planActions.reviseProposal).toHaveBeenCalledWith(
      proposalId,
      "Keep 45 minutes and make it recovery.",
    );
    const failedState = {
      ...state,
      scenarioId: "PL-S022" as const,
      data: {
        ...PlanActiveProjectionDataSchema.parse(state.data),
        proposalRevisionText: "Keep 45 minutes and make it recovery.",
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: failedState });
    });
    expect(await screen.findByLabelText("Your change")).toHaveValue(
      "Keep 45 minutes and make it recovery.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Sunday recovery" })).toBeInTheDocument();
    const currentData = PlanActiveProjectionDataSchema.parse(state.data);
    const revisedProposalId = "00000000000000000000000007";
    const revisedState = {
      ...state,
      scenarioId: "PL-S023" as const,
      data: {
        ...currentData,
        selectedProposalId: revisedProposalId,
        proposals: [
          {
            ...currentData.proposals![0]!,
            id: revisedProposalId,
            revision: 2,
            title: "Sunday recovery · revised",
          },
        ],
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: revisedState });
    });
    expect(
      await screen.findByRole("heading", { name: "Sunday recovery · revised" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Your change")).not.toBeInTheDocument();

    const staleState = {
      ...state,
      scenarioId: "PL-S025" as const,
      data: {
        ...currentData,
        selectedProposalId: revisedProposalId,
        proposals: [
          {
            ...currentData.proposals![0]!,
            id: revisedProposalId,
            revision: 2,
            title: "Sunday recovery · revised",
            stale: true,
            error: {
              code: "stale-base" as const,
              message: "The Plan changed before approval. Review the updated Proposal.",
              retryable: false,
            },
          },
        ],
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: staleState });
    });
    const revalidate = await screen.findByRole("button", { name: "Revalidate" });
    expect(revalidate).toBeEnabled();
    await user.click(revalidate);
    expect(planActions.approveProposal).toHaveBeenLastCalledWith(revisedProposalId, 2);

    const unavailableState = {
      ...state,
      transitions: state.transitions.filter(
        (guard) => guard.transitionId !== "PL-T18" && guard.transitionId !== "PL-T19",
      ),
      data: {
        ...currentData,
        selectedProposalId: proposalId,
        proposals: [
          {
            ...currentData.proposals![0]!,
            error: {
              code: "unavailable" as const,
              message: "This Plan action is not available yet.",
              retryable: true,
            },
          },
        ],
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: unavailableState });
    });
    expect(await screen.findByText("This Plan action is not available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revalidate" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();

    const rejectedState = {
      ...state,
      scenarioId: "PL-S097" as const,
      attentionCount: 0,
      data: {
        ...currentData,
        selectedProposalId: null,
        proposals: [],
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: rejectedState });
    });
    expect(await screen.findByRole("heading", { name: "Proposal rejected" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to Plan" }));
    expect(planActions.closeWorkout).toHaveBeenCalledOnce();
  });

  it("shows the outside-edit comparison and exposes explicit adopt or restore choices", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const workoutId = "00000000000000000000000004";
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S032",
      projection: "active",
      planId: "00000000000000000000000003",
      attentionCount: 1,
      data: {
        plan: {
          id: "00000000000000000000000003",
          name: "Gran Fondo Almaty",
          primaryGoal: "Finish in the front half",
          startDate: "2026-07-13",
          targetDate: "2026-10-04",
          kind: "full-plan",
          totalWeeks: 12,
          weekStartDay: 1,
          workoutCount: 20,
          plannedDurationS: 72_000,
        },
        today: "2026-08-18",
        weekIndex: 6,
        todayWorkout: null,
        workouts: [
          {
            id: workoutId,
            date: "2026-08-19",
            sport: "cycling",
            name: "Threshold 4×8",
            durationS: 4_800,
            drift: {
              status: "detected",
              eventId: "42",
              plan: { date: "2026-08-19", name: "Threshold 4×8", durationS: 4_800 },
              provider: {
                date: "2026-08-19",
                name: "Threshold 4×8",
                durationS: 3_300,
              },
              error: null,
            },
          },
        ],
        selectedWorkoutId: workoutId,
      },
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
      planActions,
    });
    render(<PlanView />);

    expect(
      screen.getByRole("heading", { name: "Wednesday changed in Intervals" }),
    ).toBeInTheDocument();
    const comparisons = screen.getAllByText("Threshold 4×8");
    expect(comparisons[0]?.parentElement).toHaveTextContent("1 h 20 min");
    expect(comparisons[1]?.parentElement).toHaveTextContent("55 min");
    await user.click(screen.getByRole("button", { name: "Adopt Intervals edit" }));
    expect(planActions.resolveWorkoutDrift).toHaveBeenCalledWith(workoutId, "42", "adopt");
    await user.click(screen.getByRole("button", { name: "Restore Plan workout" }));
    expect(planActions.resolveWorkoutDrift).toHaveBeenCalledWith(workoutId, "42", "restore");
  });

  it("renders connected Plan history and the applied, expired, and undone destinations", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const workoutId = "00000000000000000000000004";
    const ledgerId = "00000000000000000000000005";
    const undoId = "00000000000000000000000006";
    const baseData = {
      plan: {
        id: planId,
        name: "Gran Fondo Almaty",
        primaryGoal: "Finish in the front half",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 20,
        plannedDurationS: 72_000,
      },
      today: "2026-08-18",
      weekIndex: 6,
      todayWorkout: null,
      workouts: [],
      history: [
        {
          id: ledgerId,
          kind: "proposal-applied" as const,
          label: "Sunday adjustment applied",
          occurredAtMs: 1_787_477_200_000,
          targetWorkoutId: workoutId,
          before: { date: "2026-08-23", name: "Endurance", durationS: 5_400 },
          after: { date: "2026-08-23", name: "Recovery", durationS: 1_800 },
          weekLoadBefore: 420,
          weekLoadAfter: 360,
          undoStatus: "eligible" as const,
          undoReason: null,
        },
        {
          id: `activation:${planId}`,
          kind: "activation" as const,
          label: "Plan approved",
          occurredAtMs: 1_784_000_000_000,
          targetWorkoutId: null,
          before: null,
          after: null,
          weekLoadBefore: null,
          weekLoadAfter: null,
          undoStatus: "none" as const,
          undoReason: null,
        },
      ],
    };
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
      data: baseData,
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state },
        lastReady: state,
      },
      planActions,
    });
    const { container } = render(<PlanView />);

    await user.click(screen.getByRole("button", { name: "Plan history" }));
    expect(planActions.openHistory).toHaveBeenCalledOnce();

    const historyState = { ...state, scenarioId: "PL-S005" as const };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: historyState });
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Plan history" })).toHaveFocus(),
    );
    expect(screen.getByText("Sunday adjustment applied")).toBeInTheDocument();
    expect(screen.getByText("Plan approved")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    expect(
      container.querySelector(".relative.grid.pl-8 > span.absolute.bottom-4.top-4"),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(planActions.undoPlanChange).toHaveBeenCalledWith(ledgerId);

    const appliedState = {
      ...state,
      scenarioId: "PL-S008" as const,
      data: { ...baseData, selectedHistoryId: ledgerId },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: appliedState });
    });
    const appliedHeading = await screen.findByRole("heading", { name: "Recovery is now active" });
    const appliedSection = appliedHeading.closest("section");
    if (appliedSection === null) throw new TypeError("Applied result section missing.");
    expect(within(appliedSection).getByText("Endurance · 1:30")).toBeInTheDocument();
    expect(within(appliedSection).getByText("Recovery · 0:30")).toBeInTheDocument();
    expect(within(appliedSection).getByText("−60")).toBeInTheDocument();
    expect(within(appliedSection).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(
      within(appliedSection).getByRole("button", { name: "Back to Plan" }),
    ).toBeInTheDocument();

    const expiredState = {
      ...state,
      scenarioId: "PL-S026" as const,
      data: {
        ...baseData,
        selectedHistoryId: ledgerId,
        history: [
          {
            ...baseData.history[0]!,
            undoStatus: "expired" as const,
            undoReason: "newer-change" as const,
          },
          baseData.history[1]!,
        ],
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: expiredState });
    });
    const expiredHeading = await screen.findByRole("heading", { name: "Undo expired" });
    await waitFor(() => expect(expiredHeading).toHaveFocus());
    expect(screen.getByText("A newer change was applied.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to history" }));
    expect(planActions.openHistory).toHaveBeenCalledTimes(2);

    const undoEntry = {
      ...baseData.history[0]!,
      id: undoId,
      kind: "undo" as const,
      label: "Sunday adjustment undone",
      before: baseData.history[0]!.after,
      after: baseData.history[0]!.before,
      weekLoadBefore: baseData.history[0]!.weekLoadAfter,
      weekLoadAfter: baseData.history[0]!.weekLoadBefore,
      undoStatus: "undone" as const,
      undoReason: "already-undone" as const,
    };
    const undoneState = {
      ...state,
      scenarioId: "PL-S027" as const,
      data: {
        ...baseData,
        selectedHistoryId: undoId,
        history: [undoEntry, baseData.history[0]!, baseData.history[1]!],
      },
    };
    document.documentElement.setAttribute("data-theme", "dark");
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: undoneState });
    });
    const undoneHeading = await screen.findByRole("heading", { name: "Plan change undone" });
    await waitFor(() => expect(undoneHeading).toHaveFocus());
    expect(screen.getByText(/Endurance · 1:30 is restored/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to Plan" }));
    expect(planActions.closeHistory).toHaveBeenCalledOnce();
  });

  it("saves Plan settings per control and shows an automatic reduction as one result", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const ledgerId = "00000000000000000000000005";
    const baseData = {
      plan: {
        id: planId,
        name: "Gran Fondo Almaty",
        primaryGoal: "Finish in the front half",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 1,
        plannedDurationS: 2_700,
      },
      today: "2026-08-26",
      weekIndex: 7,
      todayWorkout: null,
      workouts: [],
      history: [
        {
          id: ledgerId,
          kind: "proposal-applied" as const,
          label: "Sunday duration reduced",
          occurredAtMs: 1_787_477_200_000,
          targetWorkoutId: "00000000000000000000000004",
          before: { date: "2026-08-30", name: "Endurance", durationS: 5_400 },
          after: { date: "2026-08-30", name: "Endurance", durationS: 2_700 },
          weekLoadBefore: null,
          weekLoadAfter: null,
          undoStatus: "eligible" as const,
          undoReason: null,
        },
      ],
      selectedHistoryId: ledgerId,
      settings: {
        autoApply: false,
        weeklyReview: true,
        updatedAtMs: 10,
        selectedSetting: null,
        error: null,
      },
    };
    const settingsState = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S090",
      projection: "active",
      planId,
      data: baseData,
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: settingsState },
        lastReady: settingsState,
      },
      planActions,
    });
    render(<PlanView />);

    const autoApply = screen.getByRole("switch", { name: "Auto-apply" });
    const weeklyReview = screen.getByRole("switch", { name: "Weekly review" });
    expect(autoApply).not.toBeChecked();
    expect(weeklyReview).toBeChecked();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    await user.click(autoApply);
    expect(planActions.setPlanSetting).toHaveBeenCalledWith("auto-apply", true);

    act(() => {
      useEnduragentStore.getState().setPlanSettingPending({ setting: "auto-apply", value: true });
      useEnduragentStore.getState().setPlanTransition({
        status: "submitting",
        commandId: "setting-save",
        transitionId: "PL-T22",
      });
    });
    expect(autoApply).toBeChecked();
    expect(autoApply).toBeDisabled();
    expect(weeklyReview).toBeDisabled();
    expect(screen.getByText("Saving…")).toBeInTheDocument();

    const failedState = {
      ...settingsState,
      scenarioId: "PL-S093" as const,
      data: {
        ...baseData,
        settings: {
          ...baseData.settings,
          selectedSetting: "auto-apply" as const,
          error: {
            code: "persistence-failed" as const,
            message: "Could not save.",
            retryable: true,
          },
        },
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: failedState });
      useEnduragentStore.getState().setPlanSettingPending(null);
      useEnduragentStore.getState().setPlanTransition({
        status: "failed",
        commandId: "setting-save",
        transitionId: "PL-T22",
        error: failedState.data.settings.error,
      });
    });
    expect(autoApply).not.toBeChecked();
    expect(screen.getByText("Couldn’t save · previous value restored")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(planActions.retry).toHaveBeenCalledOnce();

    const appliedState = {
      ...settingsState,
      scenarioId: "PL-S101" as const,
      data: {
        ...baseData,
        settings: { ...baseData.settings, autoApply: true, updatedAtMs: 11 },
      },
    };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: appliedState });
      useEnduragentStore.getState().setPlanTransition({ status: "idle" });
    });
    const resultHeading = await screen.findByRole("heading", {
      name: "Endurance applied automatically",
    });
    await waitFor(() => expect(resultHeading).toHaveFocus());
    const result = resultHeading.closest("section");
    if (result === null) throw new TypeError("Automatic application result missing.");
    expect(within(result).getByText("Endurance · 1:30")).toBeInTheDocument();
    expect(within(result).getByText("Endurance · 0:45")).toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Back to Plan" })).toBeInTheDocument();
  });

  it("uses production token classes for wide, compact, Light, and Dark layouts", async () => {
    const [view, page, tokens] = await Promise.all([
      readFile(resolve(import.meta.dirname, "..", "src", "ui", "plan", "PlanView.tsx"), "utf8"),
      readFile(resolve(import.meta.dirname, "..", "src", "ui", "shared", "Page.tsx"), "utf8"),
      readFile(resolve(import.meta.dirname, "..", "src", "theme", "tokens.css"), "utf8"),
    ]);

    expect(view).toContain("rounded-card bg-surface");
    expect(view).toContain("text-ink-2");
    expect(view).not.toMatch(/#[\da-f]{3,8}/iu);
    expect(page).toContain("w-[min(680px,calc(100%-64px))]");
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(tokens).toContain(':root[data-theme="light"]');
  });
});
