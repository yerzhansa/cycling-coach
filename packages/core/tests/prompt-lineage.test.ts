import { describe, it, expect } from "vitest";
import { computePromptLineage } from "../src/agent/prompt-lineage.js";
import type { PromptLineageInput } from "../src/agent/prompt-lineage.js";
import type { ModelMessage } from "ai";

const baseMessages: ModelMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];

const base: PromptLineageInput = {
  soul: "# Coach\n\nYou are a coach.",
  skills: { example: "# Example\n\nSome content." },
  ruleBlocks: ["RULE A", "RULE B"],
  toolSchemas: { memory_query: { kind: "object" }, plan_save: { kind: "object" } },
  model: "claude-x",
  systemPrompt: "# Coach\n\n---\n\nRULE A\n\n---\n\nRULE B",
  messages: baseMessages,
};

describe("computePromptLineage", () => {
  it("is deterministic and produces sha256-16 hashes", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage(base);
    expect(a).toEqual(b);
    expect(a.templateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.assembledHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("holds the template hash stable across volatile-only changes", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({
      ...base,
      systemPrompt: base.systemPrompt + "\n\n---\n\n# Athlete Context\n\nFTP 250",
      messages: [...baseMessages, { role: "user", content: "what now?" }],
    });
    expect(b.templateHash).toBe(a.templateHash);
    expect(b.assembledHash).not.toBe(a.assembledHash);
  });

  it("changes the template hash when the model id changes", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({ ...base, model: "claude-y" });
    expect(b.templateHash).not.toBe(a.templateHash);
  });

  it("changes the template hash when a rule block is dropped (Layer-3 flag-off case)", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({ ...base, ruleBlocks: ["RULE A"] });
    expect(b.templateHash).not.toBe(a.templateHash);
  });

  it("serializes tool schemas order-stably", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({
      ...base,
      toolSchemas: { plan_save: { kind: "object" }, memory_query: { kind: "object" } },
    });
    expect(b.templateHash).toBe(a.templateHash);
  });
});
