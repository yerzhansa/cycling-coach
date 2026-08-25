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
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    openDiscardConfirmation: vi.fn(),
    closeDiscardConfirmation: vi.fn(),
    discardDraft: vi.fn(),
    openRevisionComposer: vi.fn(),
    closeRevisionComposer: vi.fn(),
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
