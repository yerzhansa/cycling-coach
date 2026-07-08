import { afterEach, describe, expect, it } from "vitest";

import { classifyUnhandled, startIntervalsMock, type IntervalsMockHandle } from "./msw.js";
import type { S8aScenario } from "./types.js";

const scenario: S8aScenario = {
  id: "msw-test",
  tier: "replay",
  description: "synthetic",
  intervals: {
    athlete: { id: "i9876543" },
    activities: [{ id: 90101, start_date_local: "1998-07-01T09:00:00", name: "Endurance spin" }],
  },
  turns: [{ chatId: "c1", userMessage: "hi" }],
};

let handle: IntervalsMockHandle | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
});

describe("unhandled-request classification", () => {
  it("bypasses the model provider host ONLY in record mode", () => {
    expect(classifyUnhandled("https://api.anthropic.com/v1/messages", "record")).toBe("bypass");
    expect(classifyUnhandled("https://api.anthropic.com/v1/messages", "replay")).toBe("leak");
  });

  it("classifies any other host as a leak in both modes", () => {
    expect(classifyUnhandled("https://example.com/x", "record")).toBe("leak");
    expect(classifyUnhandled("https://example.com/x", "replay")).toBe("leak");
    expect(classifyUnhandled("not a url", "record")).toBe("leak");
  });
});

describe("replay-mode leak detection (exit-2 classification)", () => {
  it("a stray non-intervals fetch sets the leak flag with the first URL", async () => {
    handle = startIntervalsMock(scenario, "replay");
    await expect(fetch("https://example.com/leaky")).rejects.toThrow();
    expect(handle.leak.detected).toBe(true);
    expect(handle.leak.firstUrl).toContain("example.com");
  });

  it("intervals mock routes are served without tripping the leak flag", async () => {
    handle = startIntervalsMock(scenario, "replay");
    const response = await fetch("https://intervals.icu/api/v1/athlete/i9876543");
    expect(response.status).toBe(200);
    expect(handle.leak.detected).toBe(false);
  });

  it("the supplementary single-activity route serves the explicit activities section", async () => {
    handle = startIntervalsMock(scenario, "replay");
    const hit = await fetch("https://intervals.icu/api/v1/activity/90101");
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { name: string }).name).toBe("Endurance spin");
    const miss = await fetch("https://intervals.icu/api/v1/activity/90999");
    expect(miss.status).toBe(404);
    expect(handle.leak.detected).toBe(false);
  });
});
