import { describe, expect, it } from "vitest";

describe("ci gate probe", () => {
  it("fails deliberately", () => {
    expect(1).toBe(2);
  });
});
