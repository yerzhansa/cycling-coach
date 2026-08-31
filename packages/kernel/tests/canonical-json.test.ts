import { describe, expect, it } from "vitest";
import {
  canonicalNumber,
  canonicalRowJson,
  canonicalScalar,
  sortKeys,
} from "../src/store/canonical-json.js";
import type { Row } from "../src/store/ports.js";

describe("canonicalNumber", () => {
  it("renders shortest decimal strings", () => {
    expect(canonicalNumber(1.5)).toBe("1.5");
    expect(canonicalNumber(1)).toBe("1");
    expect(canonicalNumber(250.5)).toBe("250.5");
    expect(canonicalNumber(-2.5)).toBe("-2.5");
  });

  it("normalizes -0 and 0 to '0'", () => {
    expect(canonicalNumber(-0)).toBe("0");
    expect(canonicalNumber(0)).toBe("0");
  });

  it("throws on non-finite values", () => {
    expect(() => canonicalNumber(NaN)).toThrow();
    expect(() => canonicalNumber(Infinity)).toThrow();
    expect(() => canonicalNumber(-Infinity)).toThrow();
  });
});

describe("canonicalScalar", () => {
  it("tags each scalar type distinctly", () => {
    expect(canonicalScalar(null)).toEqual(["z", null]);
    expect(canonicalScalar("x")).toEqual(["s", "x"]);
    expect(canonicalScalar(7)).toEqual(["n", "7"]);
    expect(canonicalScalar(10n)).toEqual(["i", "10"]);
    expect(canonicalScalar(new Uint8Array([0, 255, 16]))).toEqual(["b", "00ff10"]);
  });
});

describe("sortKeys", () => {
  it("sorts object keys ascending, recursively", () => {
    const input = { b: 2, a: 1, nested: { z: 26, y: 25 } };
    const sorted = sortKeys(input);
    expect(JSON.stringify(sorted)).toBe(JSON.stringify({ a: 1, b: 2, nested: { y: 25, z: 26 } }));
  });

  it("preserves an own __proto__ property", () => {
    const input = JSON.parse('{"a":2,"__proto__":{"x":1}}') as Record<string, unknown>;
    const sorted = sortKeys(input);
    expect(Object.hasOwn(sorted as object, "__proto__")).toBe(true);
    expect(JSON.stringify(sorted)).toBe('{"__proto__":{"x":1},"a":2}');
  });
});

describe("canonicalRowJson", () => {
  it("produces byte-identical output regardless of key insertion order", () => {
    const rowA: Row = { a: "x", b: 250.5, c: null };
    const rowB: Row = { c: null, b: 250.5, a: "x" };
    expect(canonicalRowJson(rowA)).toBe(canonicalRowJson(rowB));
  });

  it("renders a REAL value with the ['n', ...] tag", () => {
    const row: Row = { value: 250.5 };
    expect(canonicalRowJson(row)).toBe(JSON.stringify({ value: ["n", "250.5"] }));
  });
});
