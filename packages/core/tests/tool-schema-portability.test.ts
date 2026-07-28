import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import type { IntervalsClient } from "intervals-icu-api";
import {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "../src/agent/intervals-tools.js";

describe("core tool schema portability", () => {
  it("emits plain object schemas without root combinators", async () => {
    const fakeClient = {} as IntervalsClient;
    const toolsets = [
      createPureCoreIntervalsTools(fakeClient, "UTC"),
      createCoreToolsWithSportConfig(fakeClient, ["Ride"]),
    ];

    for (const toolset of toolsets) {
      for (const registered of Object.values(toolset)) {
        const current = registered as { inputSchema: never };
        const schema = (await Promise.resolve(
          asSchema(current.inputSchema).jsonSchema,
        )) as Record<string, unknown>;
        expect(schema.type).toBe("object");
        expect(schema).not.toHaveProperty("anyOf");
        expect(schema).not.toHaveProperty("oneOf");
        expect(schema).not.toHaveProperty("allOf");
      }
    }
  });
});
