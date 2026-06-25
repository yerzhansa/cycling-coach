import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { estimateTokens } from "../src/agent/token-utils.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Memory } from "../src/memory/store.js";
import type { SportPersona } from "../src/sport.js";

const emptyMemory = { getContext: () => "" } as unknown as Memory;

// Budget guard with headroom — the cached prefix must stay well under the
// model's context window. Raised from 12_500 as the cross-sport Voice & Register
// block (plus the cycling zone reference's fully-populated
// anaerobic/neuromuscular rows) joined the static rules. A deliberate, bounded
// prefix growth, not unbounded drift; the real prefix sits a few hundred tokens
// below this ceiling.
const STATIC_PREFIX_TOKEN_CEILING = 13_000;

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
      sessionClusterGapMinutes: 30,
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
