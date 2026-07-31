import { describe, it, expect } from "vitest";
import { canonicalJson } from "../src/archive/index.js";

describe("canonicalJson", () => {
  it("is insertion-order independent", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts keys at every depth while preserving array order", () => {
    const value = {
      z: { y: 2, x: 1 },
      a: [3, 1, 2],
    };
    expect(canonicalJson(value)).toBe(
      JSON.stringify({ a: [3, 1, 2], z: { x: 1, y: 2 } }, null, 2),
    );
  });

  it("passes scalars and null through unchanged", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson({ n: null, s: "x", i: 1 })).toBe(
      JSON.stringify({ i: 1, n: null, s: "x" }, null, 2),
    );
  });
});
