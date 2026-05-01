import { describe, it, expect } from "vitest";
import { cyclingBinary } from "../src/binary.js";
import { cyclingBinary as cyclingBinaryFixture } from "../../core/tests/helpers/cycling-binary-fixture.js";

describe("cyclingBinary fixture parity", () => {
  // The fixture exists in core/tests/helpers/ to avoid a workspace cycle
  // (core → cycling-coach → core). This test guards against silent drift
  // between the fixture and the real binary it stands in for.
  it("packages/core/tests/helpers/cycling-binary-fixture.ts mirrors the real cyclingBinary", () => {
    expect(cyclingBinaryFixture).toEqual(cyclingBinary);
  });
});
