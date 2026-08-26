import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningReadModel } from "@enduragent/coach-contract";
import { useEnduragentStore } from "../src/state/store.js";
import { PlanView } from "../src/ui/plan/PlanView.js";

const model: PlanningReadModel = {
  schemaVersion: 1,
  status: "ready",
  asOfDateKey: 20260826,
  plan: {
    id: "plan-1",
    name: "Twelve-week base",
    goal: "Build consistency",
    lifecycle: "active",
    startDateKey: 20260824,
    targetDateKey: null,
    currentWeek: 1,
    totalWeeks: 12,
    phase: "Base",
    weekStartDateKey: 20260824,
    weekEndDateKey: 20260830,
    workouts: [
      {
        id: "workout-1",
        dateKey: 20260826,
        sport: "cycling",
        name: "Tempo builder",
        durationSeconds: 3600,
        origin: "coach",
        navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
      },
    ],
    todayWorkout: null,
    navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
  },
};

beforeEach(() => {
  useEnduragentStore.setState({
    planSurface: { status: "ready", value: model },
    planFocus: { destination: "plan", focus: "workout", entityId: "workout-1" },
    planReturnToChat: true,
    planActions: { refresh: vi.fn(), openFromChat: vi.fn(), backToChat: vi.fn() },
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    planSurface: { status: "loading", value: null },
    planFocus: null,
    planReturnToChat: false,
    planActions: null,
  });
});

describe("Plan read-only surface", () => {
  it("renders the Planning projection and selected workout without mutation controls", () => {
    const { container } = render(<PlanView />);
    expect(screen.getByRole("heading", { name: "Twelve-week base" })).toBeInTheDocument();
    expect(screen.getByText("Week 1 of 12")).toBeInTheDocument();
    expect(screen.getByText("Base")).toBeInTheDocument();
    const workout = screen.getByRole("article");
    expect(within(workout).getByText("Tempo builder")).toBeInTheDocument();
    expect(container.querySelector('[data-plan-focus="workout"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /save|apply|replace/i })).not.toBeInTheDocument();
  });

  it("offers Back to Chat only for Chat-originated navigation", async () => {
    const user = userEvent.setup();
    render(<PlanView />);
    await user.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(useEnduragentStore.getState().planActions?.backToChat).toHaveBeenCalledOnce();

    act(() => useEnduragentStore.setState({ planReturnToChat: false }));
    expect(screen.queryByRole("button", { name: "Back to Chat" })).not.toBeInTheDocument();
  });

  it("keeps the last safe Plan visible during refresh failure", () => {
    useEnduragentStore.setState({ planSurface: { status: "unavailable", value: model } });
    render(<PlanView />);
    expect(screen.getByText(/Showing the last saved Plan/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Twelve-week base" })).toBeInTheDocument();
  });
});
