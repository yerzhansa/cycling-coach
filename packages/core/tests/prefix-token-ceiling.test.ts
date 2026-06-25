import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { estimateTokens } from "../src/agent/token-utils.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Memory } from "../src/memory/store.js";
import type { SportPersona } from "../src/sport.js";

const emptyMemory = { getContext: () => "" } as unknown as Memory;

// Bumped to accommodate the step-budget disclosure (a data-integrity safeguard
// against half-scheduled weeks) while still bounding runaway prefix growth.
const STATIC_PREFIX_TOKEN_CEILING = 12_500;

describe("static system-prompt prefix token ceiling", () => {
  it("keeps the real cycling static prefix under the ceiling", () => {
    const prompt = buildSystemPrompt(cyclingSport, emptyMemory, "UTC");
    expect(estimateTokens(prompt)).toBeLessThan(STATIC_PREFIX_TOKEN_CEILING);
  });

  it("measures a non-trivial prefix (reads the full corpus)", () => {
    expect(
      estimateTokens(buildSystemPrompt(cyclingSport, emptyMemory, "UTC")),
    ).toBeGreaterThan(5000);
  });

  it("emits a ## Skill: header once per skill", () => {
    const persona: SportPersona = {
      soul: "# Coach",
      skills: { periodization: "P content", recovery: "R content" },
    };
    const prompt = buildSystemPrompt(persona, emptyMemory);
    expect(prompt).toContain("## Skill: periodization");
    expect(prompt).toContain("## Skill: recovery");
    expect(prompt.split("## Skill: periodization").length).toBe(2);
    expect(prompt.split("## Skill: recovery").length).toBe(2);
  });

  it("keeps the static prefix byte-stable across consecutive builds", () => {
    expect(buildSystemPrompt(cyclingSport, emptyMemory, "UTC")).toBe(
      buildSystemPrompt(cyclingSport, emptyMemory, "UTC"),
    );
  });
});
