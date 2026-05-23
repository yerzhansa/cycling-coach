import { describe, expect, it } from "vitest";
import { gateLatestJson } from "../src/reference/validation/sync-gate.js";

describe("gateLatestJson (stub)", () => {
  it("returns ok with no failures or warnings — body lands when the gate is wired", () => {
    const result = gateLatestJson({ anything: 1 }, { prior: "state" });
    expect(result).toEqual({ ok: true, failures: [], warnings: [] });
  });
});
