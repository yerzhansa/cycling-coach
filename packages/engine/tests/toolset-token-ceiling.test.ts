import { asSchema } from "@ai-sdk/provider-utils";
import { cyclingSport } from "@enduragent/sport-cycling";
import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, SAFETY_MARGIN, estimateTokens } from "../src/agent/token-utils.js";
import { createMemoryTools, getEffectiveSections } from "../src/sport.js";
import type { SportRuntimePorts, ToolRegistration } from "../src/sport.js";
import type { MemoryStorePort } from "../src/host-ports.js";

const deps = {
  llm: null,
  secrets: null,
  intervals: {},
  athleteData: {},
  calendarMutations: {},
  memory: {},
  tz: "UTC",
} as unknown as SportRuntimePorts;

async function serializeToolset(regs: readonly ToolRegistration[]): Promise<string> {
  const parts = await Promise.all(
    regs.map(async (r) => {
      const t = r.tool as { description?: string; inputSchema: never };
      const schema = await Promise.resolve(asSchema(t.inputSchema).jsonSchema);
      return JSON.stringify({ name: r.name, description: t.description ?? "", schema });
    }),
  );
  return parts.join("\n");
}

// Serialized-toolset budget guard (name + description + JSON schema per tool,
// the payload that rides position 0 of every request on every step). Pinned
// ~10% above the measured post-trim toolset; growth past it must be deliberate.
const CYCLING_TOOLSET_CHAR_CEILING = 20_000;

describe("cycling chat toolset serialized-size ceiling", () => {
  it("keeps the full 18-tool cycling toolset under the ceiling", async () => {
    const serialized = await serializeToolset(cyclingSport.tools(deps));
    expect(serialized.length).toBeLessThan(CYCLING_TOOLSET_CHAR_CEILING);
    expect(estimateTokens(serialized)).toBeLessThan(
      Math.ceil((CYCLING_TOOLSET_CHAR_CEILING / CHARS_PER_TOKEN) * SAFETY_MARGIN),
    );
  });

  it("measures a real toolset, not a stub", async () => {
    const regs = cyclingSport.tools(deps);
    expect(regs.length).toBeGreaterThanOrEqual(18);
    expect((await serializeToolset(regs)).length).toBeGreaterThan(8_000);
  });
});

describe("memory_write section catalog", () => {
  it("names every effective cycling section in ≤700 chars", async () => {
    const sections = getEffectiveSections(cyclingSport);
    const description = createMemoryTools(deps.memory, sections).memory_write.description ?? "";
    for (const section of sections) expect(description).toContain(section.name);
    expect(description.length).toBeLessThanOrEqual(700);
  });

  it("falls back to the full description when a section has no hint", () => {
    const description = createMemoryTools({} as MemoryStorePort, [
      { name: "goals", description: "Athlete goals" },
    ]).memory_write.description;
    expect(description).toContain("Athlete goals");
  });
});
