import { describe, expect, it, vi } from "vitest";
import type { PlanSurfaceState } from "../src/state/plan-slice.js";
import { createPlanController } from "../src/plan/controller.js";

const model = { schemaVersion: 1 as const, status: "no-plan" as const, asOfDateKey: 20260826, plan: null };

describe("Plan controller", () => {
  it("hydrates and preserves the last safe projection on refresh failure", async () => {
    let fail = false;
    const states: PlanSurfaceState[] = [];
    const controller = createPlanController({
      read: vi.fn(async () => {
        if (fail) throw new Error("offline");
        return model;
      }),
      render: (state) => states.push(state),
      navigate: vi.fn(),
      focus: vi.fn(),
    });
    await controller.start();
    fail = true;
    await controller.refresh();
    expect(states.at(-1)).toEqual({ status: "unavailable", value: model });
  });

  it("records Chat return navigation without mutating Plan", () => {
    const navigate = vi.fn();
    const focus = vi.fn();
    const controller = createPlanController({
      read: vi.fn(async () => model),
      render: vi.fn(),
      navigate,
      focus,
    });
    const target = { destination: "plan" as const, focus: "active-plan" as const, entityId: "plan-1" };
    controller.openFromChat(target);
    expect(focus).toHaveBeenCalledWith(target, true);
    expect(navigate).toHaveBeenCalledWith("plan");
    controller.backToChat();
    expect(focus).toHaveBeenLastCalledWith(null, false);
    expect(navigate).toHaveBeenLastCalledWith("chat");
  });
});
