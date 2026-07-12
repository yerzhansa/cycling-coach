import { asSchema } from "ai";
import {
  CHARS_PER_TOKEN,
  SAFETY_MARGIN,
  estimateTokens,
  type CoreDeps,
  type ToolRegistration,
} from "@enduragent/core";
import { describe, expect, it } from "vitest";
import { runningSport } from "../src/sport.js";

const deps = {
  llm: null,
  secrets: null,
  intervals: {},
  memory: {},
  tz: "UTC",
} as unknown as CoreDeps;

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
const RUNNING_TOOLSET_CHAR_CEILING = 16_500;

describe("running chat toolset serialized-size ceiling", () => {
  it("keeps the full 14-tool running toolset under the ceiling", async () => {
    const serialized = await serializeToolset(runningSport.tools(deps));
    expect(serialized.length).toBeLessThan(RUNNING_TOOLSET_CHAR_CEILING);
    expect(estimateTokens(serialized)).toBeLessThan(
      Math.ceil((RUNNING_TOOLSET_CHAR_CEILING / CHARS_PER_TOKEN) * SAFETY_MARGIN),
    );
  });

  it("measures a real toolset, not a stub", async () => {
    const regs = runningSport.tools(deps);
    expect(regs.length).toBeGreaterThanOrEqual(14);
    expect((await serializeToolset(regs)).length).toBeGreaterThan(6_000);
  });
});
