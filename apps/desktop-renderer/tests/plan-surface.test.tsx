import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
