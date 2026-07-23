import { describe, expect, it } from "vitest";
import soul from "../SOUL.md";
import review from "../skills/review.md";

describe("cycling review guidance", () => {
  it("uses canonical workout grouping instead of provider-only grouping fields", () => {
    expect(review).toContain("`workoutId`");
    expect(review).toContain("`sessionSequence`");
    expect(review).toContain("more than three ordered sport and transition activities");
    expect(soul).not.toContain("sub_type");
  });

  it("limits summary and lap guidance to canonical fields", () => {
    expect(review).toContain("bounded summary");
    expect(review).toContain("bounded `laps`");
    expect(review).toContain("| Lap | Start (with timezone basis) | Elapsed | Timer | Distance |");
    expect(review).toContain("more than three ordered sport and transition activities");
    expect(review).toMatch(/does not preserve\s+trustworthy timestamp/);
    expect(review).toMatch(
      /independently summarized statistics alone\s+cannot establish session quality/,
    );
    expect(review).not.toContain("per-channel sample count");
    expect(soul).not.toContain("per-channel sample count");
    expect(review).toContain("Do not calculate pacing");
    expect(review).not.toMatch(/^## (?:Decoupling|Best-efforts|Cycling fade patterns)/mu);
    expect(review).not.toMatch(/icu_intervals|paired_event_id|race=true|sub_type=RACE/);
  });
});
