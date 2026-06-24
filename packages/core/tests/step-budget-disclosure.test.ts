import { describe, it, expect } from "vitest";
import {
  staticRuleBlocks,
  buildSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  STEP_BUDGET_RULES,
} from "../src/agent/system-prompt.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Memory } from "../src/memory/store.js";

const emptyMemory = { getContext: () => "" } as unknown as Memory;

describe("step-budget disclosure block", () => {
  it("is part of the static rule-block list", () => {
    const blocks = staticRuleBlocks();
    expect(blocks).toContain(STEP_BUDGET_RULES);
    const block = blocks.find((b) => b.startsWith("# Tool-Call Budget"));
    expect(block).toBeDefined();
    expect(block).toContain("follow-up turns");
    expect(block).toContain("half-scheduled");
  });

  it("rides the cached prefix (above the cache boundary)", () => {
    const prompt = buildSystemPrompt(cyclingSport, emptyMemory, "UTC");
    const [prefix, ...rest] = prompt.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(rest.length).toBeGreaterThan(0);
    expect(prefix).toContain("# Tool-Call Budget");
  });

  it("discloses the ~10-call cap and the non-rollback warning", () => {
    expect(STEP_BUDGET_RULES).toContain("10 tool calls");
    expect(STEP_BUDGET_RULES).toContain("not rolled back");
  });
});
