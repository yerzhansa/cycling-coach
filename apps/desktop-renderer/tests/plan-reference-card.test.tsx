import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PlanningReadModel } from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEnduragentStore } from "../src/state/store.js";
import { PlanReferenceCard } from "../src/ui/chat/PlanReferenceCard.js";

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
        durationSeconds: 3_600,
        targets: "3 × 8 min · 85–90% FTP",
        purpose: "Sustainable power",
        safetyGuardrail: "Stop if the warm-up feels wrong",
        origin: "coach",
        navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
      },
    ],
    todayWorkout: null,
    navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
  },
};

afterEach(() => {
  act(() =>
    useEnduragentStore.setState({
      planSurface: { status: "loading", value: null },
      planningReadActions: null,
    }),
  );
});

describe("Plan reference card", () => {
  it("renders the frozen Workout fields and opens the typed Plan destination", async () => {
    const openFromChat = vi.fn();
    act(() =>
      useEnduragentStore.setState({
        planSurface: { status: "ready", value: model },
        planningReadActions: {
          refresh: vi.fn(),
          openFromChat,
          backToChat: vi.fn(),
          returnToChatRequest: vi.fn(),
        },
      }),
    );
    const user = userEvent.setup();
    render(
      <PlanReferenceCard
        selection={{ kind: "workout_detail", planId: "plan-1", workoutId: "workout-1" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Tempo builder" })).toBeInTheDocument();
    expect(screen.getByText("3 × 8 min · 85–90% FTP")).toBeInTheDocument();
    expect(screen.getByText("Sustainable power")).toBeInTheDocument();
    expect(screen.getByText("Stop if the warm-up feels wrong")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply|save|replace/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Plan" }));
    expect(openFromChat).toHaveBeenCalledWith({
      destination: "plan",
      focus: "workout",
      entityId: "workout-1",
    });
  });

  it("renders nothing when current Plan data cannot resolve the saved selection", () => {
    act(() =>
      useEnduragentStore.setState({
        planSurface: { status: "ready", value: model },
        planningReadActions: {
          refresh: vi.fn(),
          openFromChat: vi.fn(),
          backToChat: vi.fn(),
          returnToChatRequest: vi.fn(),
        },
      }),
    );
    const view = render(
      <PlanReferenceCard
        selection={{ kind: "workout_detail", planId: "plan-1", workoutId: "missing" }}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();
  });
});
