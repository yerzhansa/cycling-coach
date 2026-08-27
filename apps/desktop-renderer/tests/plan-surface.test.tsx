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
      data: planCoachData({
        draft,
        plan,
        startDate,
        course: {
          status: "omitted",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
    useEnduragentStore.setState({
      plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state }, lastReady: state },
      planActions,
    });
    render(<PlanView />);
    expect(screen.getByRole("heading", { name: "Race Course · optional" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Race Course$/ })).not.toBeInTheDocument();

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

  it("shows natural completion, records the race outcome, and preserves the ended Plan", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const plan = {
      id: planId,
      name: "Gran Fondo Almaty",
      primaryGoal: "Finish in the front half",
      startDate: "1998-07-13",
      targetDate: "1998-10-04",
      kind: "full-plan" as const,
      totalWeeks: 12,
      weekStartDay: 1,
      workoutCount: 20,
      plannedDurationS: 72_000,
    };
    const reconciliation = {
      status: "verified" as const,
      created: 0,
      pending: 0,
      failed: 0,
      total: 0,
      currentThrough: "1998-10-06",
      error: null,
    };
    const natural = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S094",
      projection: "ended",
      planId,
      reconciliation,
      data: {
        plan,
        endedAtMs: 20,
        raceOutcome: null,
        outcomeAvailable: true,
        cleanupItems: [],
      },
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: natural },
        lastReady: natural,
      },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByText(/ended automatically after/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record outcome" }));
    expect(planActions.openRaceOutcome).toHaveBeenCalledOnce();

    const choice = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S095",
      projection: "ended",
      planId,
      reconciliation,
      data: {
        plan,
        endedAtMs: 20,
        raceOutcome: null,
        outcomeAvailable: true,
        cleanupItems: [],
      },
    });
    act(() => useEnduragentStore.getState().setPlanHydration({ status: "ready", state: choice }));
    expect(
      screen.getByRole("heading", { name: "Did you complete Gran Fondo Almaty?" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Not completed" }));
    expect(planActions.recordRaceOutcome).toHaveBeenCalledWith("not-completed");

    const notCompleted = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S096",
      projection: "ended",
      planId,
      reconciliation,
      data: {
        plan,
        endedAtMs: 20,
        raceOutcome: "not-completed",
        outcomeAvailable: false,
        cleanupItems: [],
      },
    });
    act(() =>
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: notCompleted }),
    );
    expect(screen.getByText("Not completed", { selector: "strong" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start a new Plan" }));
    expect(planActions.startPlan).toHaveBeenCalledOnce();
  });

  it("opens an ended Plan conversation as read-only History", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const plan = {
      id: planId,
      name: "Gran Fondo Almaty",
      primaryGoal: "Finish in the front half",
      startDate: "1998-07-13",
      targetDate: "1998-10-04",
      kind: "full-plan" as const,
      totalWeeks: 12,
      weekStartDay: 1,
      workoutCount: 20,
      plannedDurationS: 72_000,
    };
    const ended = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S089",
      projection: "ended",
      planId,
      reconciliation: {
        status: "verified",
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: "1998-10-06",
        error: null,
      },
      data: { plan, endedAtMs: 20, cleanupItems: [] },
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: ended },
        lastReady: ended,
      },
      planActions,
    });
    render(<PlanView />);

    await user.click(screen.getByRole("button", { name: "View coach conversation" }));
    expect(planActions.openEndedConversation).toHaveBeenCalledOnce();

    const history = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S102",
      projection: "coach",
      planId,
      data: planCoachData({
        messages: [
          {
            id: "coach-1",
            turnId: null,
            role: "coach",
            text: "Let’s build this here in Plan.",
          },
          {
            id: "athlete-1",
            turnId: "turn-1",
            role: "athlete",
            text: "Gran Fondo Almaty on 4 October.",
          },
        ],
      }),
    });
    act(() => useEnduragentStore.getState().setPlanHydration({ status: "ready", state: history }));
    expect(screen.getByRole("heading", { name: "Plan conversation" })).toBeInTheDocument();
    expect(screen.getByText("Gran Fondo Almaty on 4 October.")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Reply to your Plan coach" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to ended Plan" }));
    expect(planActions.closeEndedConversation).toHaveBeenCalledOnce();
  });

  it("keeps replacement confirmation safe and cleanup recovery explicit", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const previousPlanId = "00000000000000000000000003";
    const replacementPlanId = "00000000000000000000000004";
    const draft = {
      id: "00000000000000000000000005",
      planId: replacementPlanId,
      revision: 2,
      status: "ready" as const,
      snapshot: {},
    };
    const confirmation = planReadModel({
      lifecycle: "replacement-draft",
      scenarioId: "PL-S081",
      projection: "draft",
      planId: replacementPlanId,
      revision: 2,
      data: planCoachData({
        replacement: true,
        replacesPlanId: previousPlanId,
        draft,
      }),
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
    expect(dialog).toHaveTextContent("The old Plan ends and the replacement activates locally");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.click(within(dialog).getByRole("button", { name: "Replace Plan" }));
    expect(planActions.confirmReplacement).toHaveBeenCalledOnce();

    const replacementData = {
      plan: {
        id: replacementPlanId,
        name: "Replacement Plan",
        primaryGoal: "Finish",
        startDate: "2026-08-27",
        targetDate: "2026-11-18",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 4,
        workoutCount: 1,
        plannedDurationS: 3_600,
      },
      today: "2026-08-26",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [],
      replacement: {
        id: "00000000000000000000000006",
        previousPlan: {
          id: previousPlanId,
          name: "Previous Plan",
          primaryGoal: "Finish",
          startDate: "2026-07-09",
          targetDate: "2026-09-30",
          kind: "full-plan" as const,
          totalWeeks: 12,
          weekStartDay: 4,
          workoutCount: 0,
          plannedDurationS: 0,
        },
        activatedAtMs: 100,
        cleanupItems: [
          {
            id: "00000000000000000000000007",
            date: "2026-08-27",
            externalId: `cycling-coach:plan:${previousPlanId}:workout`,
            status: "failed" as const,
            errorCode: "calendar-delete-failed",
          },
        ],
      },
    };
    const failed = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S083",
      projection: "active",
      planId: replacementPlanId,
      attentionCount: 1,
      data: replacementData,
    });
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: failed });
    });
    expect(
      screen.getByRole("heading", { name: "Old Plan cleanup needs attention" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Still in Intervals")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue anyway/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify again" }));
    await user.click(screen.getByRole("button", { name: "Retry cleanup" }));
    expect(planActions.verifyReplacementCleanup).toHaveBeenCalledOnce();
    expect(planActions.retryReplacementCleanup).toHaveBeenCalledOnce();

    const verified = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S085",
      projection: "active",
      planId: replacementPlanId,
      data: {
        ...replacementData,
        replacement: { ...replacementData.replacement, cleanupItems: [] },
      },
    });
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: verified });
    });
    await user.click(screen.getByRole("button", { name: "Write next 7 days" }));
    expect(planActions.writeReplacementMirror).toHaveBeenCalledOnce();

    const completed = { ...verified, scenarioId: "PL-S087" as const };
    act(() => {
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: completed });
    });
    expect(screen.getByRole("heading", { name: "Replacement complete" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open active Plan" }));
    expect(planActions.openReplacementActivePlan).toHaveBeenCalledOnce();
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
              createdAtMs: 1_787_477_200_000,
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
              createdAtMs: 1_787_477_200_000,
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
              detectedAtMs: 1_787_477_200_000,
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

  it("renders the complete Season and authoritative Race week at compact-safe widths", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const raceWorkoutId = "00000000000000000000000004";
    const weeks = Array.from({ length: 12 }, (_, index) => {
      const start = new Date(Date.UTC(2026, 6, 13 + index * 7));
      const end = new Date(Date.UTC(2026, 6, 19 + index * 7));
      return {
        weekIndex: index + 1,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        phase: index === 11 ? "Race" : index >= 10 ? "Taper" : "Build",
        purpose: index === 11 ? "Goal race" : "Follow the approved week",
        status:
          index === 5
            ? ("current" as const)
            : index < 5
              ? ("completed" as const)
              : ("planned" as const),
        plannedDurationS: index === 11 ? 29_100 : 32_400,
      };
    });
    const raceDays = [
      ["2026-09-28", "Mon", null, "Rest", null, "Absorb", "rest"],
      ["2026-09-29", "Tue", "openers", "Openers · 3×1 min", 2_700, "Sharpen", "training"],
      ["2026-09-30", "Wed", "easy", "Easy endurance", 3_000, "Maintain", "training"],
      ["2026-10-01", "Thu", null, "Rest", null, "Absorb", "rest"],
      ["2026-10-02", "Fri", "opener", "Race opener", 1_800, "Blocked", "training"],
      ["2026-10-03", "Sat", "spin", "Pre-race spin", 3_600, "Prime", "training"],
      ["2026-10-04", "Sun", raceWorkoutId, "Gran Fondo Almaty", 18_000, "Race", "race"],
    ].map(([date, weekday, workoutId, name, durationS, purpose, kind]) => ({
      date,
      weekday,
      workoutId,
      name,
      durationS,
      purpose,
      kind,
    }));
    const data = PlanActiveProjectionDataSchema.parse({
      plan: {
        id: planId,
        name: "Gran Fondo Almaty",
        primaryGoal: "Finish in the front half",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan",
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 58,
        plannedDurationS: 309_600,
      },
      today: "2026-08-18",
      weekIndex: 6,
      todayWorkout: null,
      workouts: [],
      matchSync: { lastSuccessfulSyncAtMs: 1_787_477_200_000, awaitingSync: true },
      selectedWorkoutId: null,
      season: {
        priority: "A",
        distanceKm: 120,
        weeks,
        constraint: {
          weekIndex: 8,
          title: "FTP refresh required before Build 2",
          detail: "Later durations stay fixed; power targets wait for refreshed FTP.",
        },
        raceWeek: {
          startDate: "2026-09-28",
          endDate: "2026-10-04",
          raceDate: "2026-10-04",
          trainingDurationS: 11_100,
          raceDurationS: 18_000,
          totalDurationS: 29_100,
          days: raceDays,
        },
      },
    });
    const seasonState = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S006",
      projection: "active",
      planId,
      data,
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: seasonState },
        lastReady: seasonState,
      },
      planActions,
    });
    render(<PlanView />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Season" })).toHaveFocus());
    expect(screen.getByRole("columnheader", { name: "Week" })).toBeInTheDocument();
    expect(screen.getByText("Wk 12")).toBeInTheDocument();
    expect(screen.getByRole("row", { current: true })).toHaveTextContent("Wk 6");
    expect(screen.getByText(/FTP refresh required before Build 2/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Race week" }));
    expect(planActions.openRaceWeek).toHaveBeenCalledOnce();

    const raceState = { ...seasonState, scenarioId: "PL-S009" as const };
    document.documentElement.setAttribute("data-theme", "dark");
    act(() =>
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: raceState }),
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Race week" })).toHaveFocus());
    expect(screen.getByText("3:05")).toBeInTheDocument();
    expect(screen.getAllByText("5:00")).toHaveLength(2);
    expect(screen.getByText("8:05")).toBeInTheDocument();
    expect(screen.getByText(/Plan below is authoritative/u)).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toHaveClass("text-warn");
    expect(screen.getAllByRole("row")).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "Gran Fondo Almaty" }));
    expect(planActions.openWorkout).toHaveBeenCalledWith(raceWorkoutId);
    const workoutDetailState = {
      ...raceState,
      scenarioId: "PL-S021" as const,
      data: {
        ...data,
        selectedWorkoutId: raceWorkoutId,
        selectedWorkoutSourceScenarioId: "PL-S009" as const,
        selectedWorkout: {
          id: raceWorkoutId,
          date: "2026-10-04",
          sport: "cycling",
          name: "Gran Fondo Almaty",
          durationS: 18_000,
        },
      },
    };
    act(() =>
      useEnduragentStore
        .getState()
        .setPlanHydration({ status: "ready", state: workoutDetailState }),
    );
    const returnedRaceState = {
      ...raceState,
      data: {
        ...data,
        returnFocusId: `race-week-workout-${raceWorkoutId}`,
      },
    };
    act(() =>
      useEnduragentStore.getState().setPlanHydration({ status: "ready", state: returnedRaceState }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Gran Fondo Almaty" })).toHaveFocus(),
    );
    await user.click(screen.getByRole("button", { name: "Back to Season" }));
    expect(planActions.closeRaceWeek).toHaveBeenCalledOnce();
  });

  it("renders every Race readiness state and returns focus to its active-Plan trigger", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const baseData = PlanActiveProjectionDataSchema.parse({
      plan: {
        id: planId,
        name: "Gran Fondo Almaty",
        primaryGoal: "Finish in the front half",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan",
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 58,
        plannedDurationS: 309_600,
      },
      today: "2026-08-22",
      weekIndex: 6,
      todayWorkout: null,
      workouts: [],
      readiness: {
        form: {
          status: "available",
          asOf: "2026-08-22",
          current: 1,
          raceRange: { min: 4, max: 9 },
          assumptions: ["Planned training", "Normal recovery"],
          unavailableReason: null,
          lastSuccessfulRefreshAtMs: 1_777_000_000_000,
        },
        feasibility: {
          verdict: "on-track",
          supportedDistanceKm: { min: 135, max: 145 },
          reasons: ["The modeled range supports the goal"],
          recommendation: "Continue the approved Plan",
        },
        courseEstimate: {
          status: "available",
          rangeMinutes: { min: 288, max: 312 },
          previousRangeMinutes: null,
          confidence: "moderate",
          assumptions: ["Dry roads", "Low wind"],
          changedAssumption: null,
          unavailableReason: null,
        },
        estimatedCp: {
          status: "available",
          watts: 287,
          calculatedOn: "2026-08-22",
          lastSuccessfulSyncAtMs: 1_777_000_000_000,
          unavailableReason: null,
          efforts: [
            {
              activityId: "ride-short",
              ride: "Tuesday Hill Repeats",
              date: "2026-08-18",
              durationS: 180,
              averagePowerW: 407,
              device: "Favero Assioma Duo",
            },
            {
              activityId: "ride-long",
              ride: "Sunday Tempo Climb",
              date: "2026-08-09",
              durationS: 900,
              averagePowerW: 311,
              device: "Garmin Rally RS200",
            },
          ],
        },
        evidence: {
          prescribedDurationS: 154_800,
          riddenDurationS: 142_800,
          adjustedDurationS: 7_800,
          missedKeyWorkouts: 0,
          fatigue: "normal",
        },
        taperRefusal: null,
        error: null,
      },
    });
    const active = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
      data: baseData,
    });
    useEnduragentStore.setState({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: active },
        lastReady: active,
      },
      planActions,
    });
    render(<PlanView />);

    expect(screen.getByRole("heading", { name: "Predictions" })).toBeInTheDocument();
    expect(screen.getByText("Race-day form")).toBeInTheDocument();
    expect(screen.getByText("+4 to +9")).toBeInTheDocument();
    expect(screen.getByText("On track — with assumptions")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "View race readiness" });
    await user.click(trigger);
    expect(planActions.openReadiness).toHaveBeenCalledOnce();

    const baseReadiness = baseData.readiness;
    if (baseReadiness === undefined) throw new TypeError("Readiness fixture missing.");
    const show = (scenarioId: string, readiness = baseReadiness): void => {
      const state = planReadModel({
        lifecycle: "active",
        scenarioId,
        projection: "active",
        planId,
        data: { ...baseData, readiness },
      });
      act(() => useEnduragentStore.getState().setPlanHydration({ status: "ready", state }));
    };
    show("PL-S012");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Race readiness" })).toHaveFocus(),
    );
    expect(screen.getByText("+1 → +4 to +9")).toBeInTheDocument();
    expect(screen.getByText("4 h 48–5 h 12")).toBeInTheDocument();
    expect(screen.getByText("287 W")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();

    const cpInfo = screen.getByRole("button", { name: "About Estimated CP" });
    await user.click(cpInfo);
    expect(
      screen.getByText(
        "Based on your best short and long power efforts from the last 6 weeks. This does not change your FTP, zones, workouts, or Plan.",
      ),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(cpInfo).toHaveFocus());

    const effortsTrigger = screen.getByRole("button", { name: "View the 2 efforts used →" });
    await user.click(effortsTrigger);
    const effortsDrawer = screen.getByRole("dialog", { name: "Power efforts used" });
    expect(within(effortsDrawer).getByText("3:00 at 407 W")).toBeInTheDocument();
    expect(within(effortsDrawer).getByText("15:00 at 311 W")).toBeInTheDocument();
    expect(within(effortsDrawer).getByText("Device · Favero Assioma Duo")).toBeInTheDocument();
    expect(within(effortsDrawer).getByText("Device · Garmin Rally RS200")).toBeInTheDocument();
    await user.click(within(effortsDrawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(effortsTrigger).toHaveFocus());

    const routeTrigger = screen.getByRole("button", { name: "View route assumptions →" });
    await user.click(routeTrigger);
    const routeDrawer = screen.getByRole("dialog", { name: "Route assumptions" });
    expect(within(routeDrawer).getByText("Dry roads")).toBeInTheDocument();
    expect(within(routeDrawer).getByText("Low wind")).toBeInTheDocument();
    await user.click(within(routeDrawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(routeTrigger).toHaveFocus());
    expect(planActions.saveFtp).not.toHaveBeenCalled();
    expect(planActions.updateDraft).not.toHaveBeenCalled();
    expect(planActions.reconcilePlan).not.toHaveBeenCalled();

    show("PL-S012", {
      ...baseReadiness,
      estimatedCp: {
        status: "unavailable",
        watts: null,
        calculatedOn: null,
        lastSuccessfulSyncAtMs: 1_777_000_000_000,
        unavailableReason: "missing-effort",
        efforts: [],
      },
    });
    expect(screen.getByText("Not enough measured power yet.")).toBeInTheDocument();

    show("PL-S012", {
      ...baseReadiness,
      estimatedCp: { ...baseReadiness.estimatedCp, status: "stale" },
    });
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText(/Last successful sync/u)).toBeInTheDocument();

    show("PL-S074", {
      ...baseReadiness,
      feasibility: {
        verdict: "at-risk",
        supportedDistanceKm: { min: 100, max: 110 },
        reasons: ["Fatigue is above normal", "2 key Workouts were missed"],
        recommendation: "Protect recovery this week",
      },
    });
    expect(screen.getByText("At risk")).toBeInTheDocument();
    expect(screen.getByText("Protect recovery this week")).toBeInTheDocument();

    show("PL-S075", {
      ...baseReadiness,
      courseEstimate: {
        status: "unavailable",
        rangeMinutes: null,
        previousRangeMinutes: null,
        confidence: null,
        assumptions: [],
        changedAssumption: null,
        unavailableReason: "missing-course",
      },
    });
    expect(
      screen.getByRole("heading", { name: "Finish-time estimate unavailable" }),
    ).toBeInTheDocument();

    show("PL-S076", {
      ...baseReadiness,
      form: {
        ...baseReadiness.form,
        status: "unavailable",
        raceRange: null,
        unavailableReason: "refresh-failed",
      },
      error: { code: "provider-failed", message: "Refresh failed.", retryable: true },
    });
    await user.click(screen.getByRole("button", { name: "Retry refresh" }));
    expect(planActions.refreshReadiness).toHaveBeenCalledOnce();

    act(() =>
      useEnduragentStore.getState().setPlanTransition({
        status: "running",
        commandId: "refresh",
        transitionId: "PL-T32",
        operationId: "operation",
        progress: null,
      }),
    );
    expect(screen.getByRole("heading", { name: "Refreshing training load" })).toBeInTheDocument();
    act(() => useEnduragentStore.getState().setPlanTransition({ status: "idle" }));

    show("PL-S077", {
      ...baseReadiness,
      courseEstimate: {
        ...baseReadiness.courseEstimate,
        status: "changed",
        previousRangeMinutes: { min: 288, max: 312 },
        rangeMinutes: { min: 300, max: 328 },
        changedAssumption: "Wind is now moderate instead of low.",
      },
    });
    expect(screen.getByText("5 h 00–5 h 28")).toBeInTheDocument();
    const changedAssumptions = screen.getByRole("button", { name: "View assumptions →" });
    await user.click(changedAssumptions);
    expect(screen.getByRole("dialog", { name: "Route assumptions" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(changedAssumptions).toHaveFocus());

    show("PL-S078", {
      ...baseReadiness,
      taperRefusal: {
        requested: "Threshold 4×8 · 1:20",
        kept: "Race opener · 0:30",
        reason: "Adding missed work during taper would reduce freshness before the race.",
      },
    });
    expect(screen.getByRole("heading", { name: "Hard Workout not added" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Plan" }));
    expect(planActions.closeReadiness).toHaveBeenCalledOnce();
    const returned = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
      data: { ...baseData, returnFocusId: "plan-readiness-trigger" },
    });
    act(() => useEnduragentStore.getState().setPlanHydration({ status: "ready", state: returned }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "View race readiness" })).toHaveFocus(),
    );
  });

  it("shows the delivered Weekly review inside Plan without a response composer", async () => {
    const user = userEvent.setup();
    const planActions = actions();
    const planId = "00000000000000000000000003";
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S100",
      projection: "active",
      planId,
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
          workoutCount: 0,
          plannedDurationS: 0,
        },
        today: "2026-08-26",
        weekIndex: 7,
        todayWorkout: null,
        workouts: [],
        weeklyReview: {
          status: "delivered",
          id: "00000000000000000000000004",
          weekStart: "2026-08-17",
          weekEnd: "2026-08-23",
          deliveredAtMs: 1,
          counts: { asPlanned: 3, adjusted: 1, moved: 0, missed: 1, extra: 1 },
          summary: "Last week: 3 as planned, 1 adjusted, 0 moved, 1 missed, 1 extra.",
        },
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

    expect(screen.getByRole("heading", { name: "Weekly review" })).toBeInTheDocument();
    expect(screen.getByText("No response is needed.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to Plan" }));
    expect(planActions.closeWorkout).toHaveBeenCalledOnce();
  });

  it("uses production token classes for wide, compact, Light, and Dark layouts", async () => {
    const [view, page, tokens] = await Promise.all([
      readFile(resolve(import.meta.dirname, "..", "src", "ui", "plan", "PlanView.tsx"), "utf8"),
      readFile(resolve(import.meta.dirname, "..", "src", "ui", "shared", "Page.tsx"), "utf8"),
      readFile(resolve(import.meta.dirname, "..", "src", "theme", "tokens.css"), "utf8"),
    ]);

    expect(view).toContain("rounded-card bg-surface");
    expect(view).toContain("min-w-[720px]");
    expect(view).toContain("overflow-x-auto");
    expect(view).toContain("text-ink-2");
    expect(view).not.toMatch(/#[\da-f]{3,8}/iu);
    expect(page).toContain("w-[min(680px,calc(100%-64px))]");
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(tokens).toContain(':root[data-theme="light"]');
  });
});
