import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  splitSystemPromptAtBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../src/agent/system-prompt.js";
import type { SportPersona } from "../src/sport.js";
import type { Memory } from "../../core/src/memory/store.js";

const persona: SportPersona = {
  soul: "# Cycling Coach\n\nYou are a cycling coach.",
  skills: { example: "# Example Skill\n\nSome cycling content." },
  sessionClusterGapMinutes: 30,
};

function mem(context = ""): Memory {
  return { getContext: () => context } as unknown as Memory;
}

const MARKER_TEXT = SYSTEM_PROMPT_CACHE_BOUNDARY.replace(/^\n\n---\n\n/, "");

describe("splitSystemPromptAtBoundary", () => {
  it("makes the marker the first line of block 2", () => {
    const blocks = splitSystemPromptAtBoundary(buildSystemPrompt(persona, mem("ctx")))!;
    expect(blocks.volatile.split("\n")[0]).toBe(MARKER_TEXT);
  });

  it("splits losslessly with the boundary appearing exactly once", () => {
    const prompt = buildSystemPrompt(persona, mem("ctx"));
    const blocks = splitSystemPromptAtBoundary(prompt)!;
    expect(blocks.prefix + "\n\n---\n\n" + blocks.volatile).toBe(prompt);
    expect(prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)).toBe(prompt.lastIndexOf(SYSTEM_PROMPT_CACHE_BOUNDARY));
  });

  it("keeps the stable rules in the prefix and the volatile context in block 2", () => {
    const blocks = splitSystemPromptAtBoundary(buildSystemPrompt(persona, mem("ctx")))!;
    expect(blocks.prefix).toContain("# Tool-Call Budget");
    expect(blocks.prefix).not.toContain("# Athlete Context");
    expect(blocks.prefix).not.toContain("Time zone:");
    expect(blocks.volatile).toContain("# Athlete Context");
    expect(blocks.volatile).toContain("Time zone:");
  });

  it("renders the degrade block inside block 2, never the prefix", () => {
    const blocks = splitSystemPromptAtBoundary(
      buildSystemPrompt(persona, mem("ctx"), "UTC", "DEGRADE-SENTINEL"),
    )!;
    expect(blocks.volatile).toContain("DEGRADE-SENTINEL");
    expect(blocks.prefix).not.toContain("DEGRADE-SENTINEL");
  });

  it("still heads block 2 with the marker when context is empty", () => {
    const blocks = splitSystemPromptAtBoundary(buildSystemPrompt(persona, mem("")))!;
    expect(blocks.volatile.split("\n")[0]).toBe(MARKER_TEXT);
    expect(blocks.volatile).toContain("# Current Date & Time");
  });

  it("returns undefined for a marker-less input", () => {
    expect(splitSystemPromptAtBoundary("no boundary here")).toBeUndefined();
  });
});

