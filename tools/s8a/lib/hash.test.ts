import { describe, expect, it } from "vitest";

import { assembledHash, sha256_16 } from "./hash.js";

describe("s8a hash reimplementations", () => {
  it("pins sha256_16 to a known vector", () => {
    expect(sha256_16("s8a")).toBe("ecfa42bb996d4678");
  });

  it("pins assembledHash to a known vector", () => {
    expect(assembledHash("sys", [{ role: "user", content: "x" }])).toBe("2015a31c26fc44e0");
  });

  it("is key-order sensitive (raw JSON.stringify, never stable-serialized)", () => {
    const a = assembledHash("sys", [{ role: "user", content: "x" }]);
    const b = assembledHash("sys", [{ content: "x", role: "user" }]);
    expect(a).not.toBe(b);
  });
});
