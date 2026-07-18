import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { CoachEngine as ContractCoachEngine } from "@enduragent/coach-contract";
import type {
  CoachEngine,
  CoachEngineFactory,
  CreateCoachEngineInput,
  EngineHostPorts,
} from "@enduragent/engine";
import type { Sport } from "@enduragent/engine/sport";

// @ts-expect-error The export map must deny every engine-internal deep import.
import type { EngineHostPorts as ForbiddenDeepImport } from "@enduragent/engine/host-ports";

const deepImportMustStayUnresolvable = null as unknown as ForbiddenDeepImport;
void deepImportMustStayUnresolvable;

describe("engine scaffold", () => {
  it("pins the only two public package entry points", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: unknown };
    expect(manifest.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./sport": {
        types: "./dist/sport.d.ts",
        import: "./dist/sport.js",
      },
    });
  });

  it("exports no runtime behavior", async () => {
    expect(Object.keys(await import("@enduragent/engine"))).toEqual([]);
    expect(Object.keys(await import("@enduragent/engine/sport"))).toEqual([]);
  });

  it("reuses the contract and pins the injected factory input", () => {
    expectTypeOf<CoachEngine>().toEqualTypeOf<ContractCoachEngine>();
    expectTypeOf<CoachEngineFactory>().toBeFunction();
    expectTypeOf<CreateCoachEngineInput>().toEqualTypeOf<{
      readonly sport: Sport;
      readonly ports: EngineHostPorts;
    }>();
  });
});
