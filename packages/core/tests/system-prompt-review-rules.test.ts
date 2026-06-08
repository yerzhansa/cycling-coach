import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import type { SportPersona } from "../src/sport.js";
import type { Memory } from "../src/memory/store.js";

function makeFakeMemory(context = ""): Memory {
  return {
    getContext: () => context,
  } as unknown as Memory;
}

const persona: SportPersona = {
  soul: "# Cycling Coach\n\nYou are a cycling coach.",
  skills: { example: "# Example Skill\n\nSome cycling content." },
};

describe("buildSystemPrompt — review + data-grounding placement", () => {
  it("places WORKOUT_REVIEW_RULES second-to-last and Data Grounding last", () => {
    const prompt = buildSystemPrompt(persona, makeFakeMemory("athlete context"));
    const sections = prompt.split("\n\n---\n\n");
    const review = sections[sections.length - 2];
    const last = sections[sections.length - 1];
    expect(review).toMatch(/^# Workout Review/);
    expect(review).toContain("3-questions framework");
    expect(last).toMatch(/^# Data Grounding/);
  });

  it("places Data Grounding last even when context is empty", () => {
    const prompt = buildSystemPrompt(persona, makeFakeMemory(""));
    const sections = prompt.split("\n\n---\n\n");
    const last = sections[sections.length - 1];
    expect(last).toMatch(/^# Data Grounding/);
  });

  it("places Data Grounding last when skills are empty", () => {
    const prompt = buildSystemPrompt({ ...persona, skills: {} }, makeFakeMemory("ctx"));
    const sections = prompt.split("\n\n---\n\n");
    expect(sections[sections.length - 1]).toMatch(/^# Data Grounding/);
  });

  it("preserves [soul, skills, context, time, review-rules, data-grounding] order", () => {
    const prompt = buildSystemPrompt(persona, makeFakeMemory("ctx"));
    const sections = prompt.split("\n\n---\n\n");
    expect(sections[0]).toContain("Cycling Coach");
    expect(sections[1]).toMatch(/^# Domain Knowledge/);
    expect(sections[2]).toMatch(/^# Athlete Context/);
    expect(sections[3]).toMatch(/^# Current Date & Time/);
    expect(sections[4]).toMatch(/^# Workout Review/);
    expect(sections[5]).toMatch(/^# Data Grounding/);
    expect(sections.length).toBe(6);
  });

  it("injects the Layer-3 data-grounding marker", () => {
    const prompt = buildSystemPrompt(persona, makeFakeMemory("ctx"));
    expect(prompt).toContain(
      "Numeric claims MUST come from the current JSON snapshot you read this turn",
    );
  });
});

describe("WORKOUT_REVIEW_RULES content", () => {
  const prompt = buildSystemPrompt(persona, makeFakeMemory(""));

  it("contains the 3-questions framework heading", () => {
    expect(prompt).toContain("3-questions framework");
  });

  it("contains the show-numbers footer line", () => {
    expect(prompt).toContain("Reply 'show numbers' for the full breakdown.");
  });

  it("contains the deeper-analysis footer line", () => {
    expect(prompt).toContain("For a deeper analysis, type /review deep.");
  });

  it("lists all six trademark forbids", () => {
    for (const tok of ["NP", "TSS", "IF", "CTL", "ATL", "TSB"]) {
      expect(prompt).toContain(`**${tok}**`);
    }
  });

  it("forbids 'true FTP'", () => {
    expect(prompt).toContain('"true FTP"');
  });

  it("declares Tier A/B/C word budgets", () => {
    expect(prompt).toContain("~50 words");
    expect(prompt).toContain("~200 words");
    expect(prompt).toContain("~500–600 words");
  });

  it("declares depth-flag → vocabulary mapping (mixed default, technical for deep)", () => {
    expect(prompt).toMatch(/Default `\/review`.*\*\*mixed\*\*/);
    expect(prompt).toMatch(/`\/review deep`.*\*\*technical\*\*/);
  });

  it("contains the multi-activity coordination clause", () => {
    expect(prompt).toContain("only on the activity matching the planned workout");
  });

  it("contains the natural-language scoping clause", () => {
    expect(prompt).toMatch(/remaining text as a scoping hint/);
  });
});
