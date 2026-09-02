import { describe, expect, it } from "vitest";
import { strictUtf8Length } from "../src/strict-utf8.js";

describe("strict UTF-8 length", () => {
  it("counts valid scalar values and rejects unpaired surrogates", () => {
    expect(strictUtf8Length("aé🚲")).toBe(7);
    expect(strictUtf8Length("\ud800")).toBeUndefined();
    expect(strictUtf8Length("\udc00")).toBeUndefined();
  });
});
