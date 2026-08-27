import { describe, expect, it } from "vitest";
import { getSampleWeek } from "../src/templates.js";

describe("cycling sample week", () => {
  it("keeps Gran Fondo priority sessions when only one or two days are available", () => {
    expect(getSampleWeek("low", "fixed", ["sat"], "sat", 1)).toMatchObject([
      { day: "Sat", type: "long" },
    ]);
    expect(getSampleWeek("low", "fixed", ["tue", "sat"], "sat", 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day: "Tue", type: "sweet_spot" }),
        expect.objectContaining({ day: "Sat", type: "long" }),
      ]),
    );
  });
});
