import { describe, expect, it } from "vitest";

import { canonicalJson, stableSerialize } from "./canonical.js";

describe("s8a canonical serialization", () => {
  it("sorts nested object keys", () => {
    expect(stableSerialize({ b: { d: 1, c: 2 }, a: 3 })).toEqual({ a: 3, b: { c: 2, d: 1 } });
    expect(JSON.stringify(stableSerialize({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it("maps arrays and passes primitives through", () => {
    expect(stableSerialize([{ b: 1, a: 2 }, "x", 3, null, true])).toEqual([
      { a: 2, b: 1 },
      "x",
      3,
      null,
      true,
    ]);
  });

  it("treats key-reordered JSON as equal under canonical compare", () => {
    const left = JSON.parse('{"outer":{"b":1,"a":[{"y":2,"x":1}]}}');
    const right = JSON.parse('{"outer":{"a":[{"x":1,"y":2}],"b":1}}');
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });
});
