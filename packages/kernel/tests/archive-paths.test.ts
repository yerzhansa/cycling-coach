import { describe, it, expect } from "vitest";
import {
  artifactRelPath,
  assertValidAddress,
  InvalidArtifactExtensionError,
  InvalidContentAddressError,
  normalizeExt,
  quarantineReasonRelPath,
  quarantineRelPath,
  shardFromInstant,
  snapshotRelPath,
  toHex,
} from "../src/archive/index.js";

const ADDR = "a".repeat(64);
const BAD_ADDR = "z".repeat(64);
const WHEN = { epochSeconds: 1615766400 }; // 2021-03-15T00:00:00Z

describe("shardFromInstant", () => {
  it("derives the UTC year and zero-padded month", () => {
    expect(shardFromInstant(WHEN)).toEqual({ year: "2021", month: "03" });
  });

  it("zero-pads a January month to 01", () => {
    const when = { epochSeconds: Date.UTC(2021, 0, 15) / 1000 };
    expect(shardFromInstant(when).month).toBe("01");
  });

  it("renders December as 12", () => {
    const when = { epochSeconds: Date.UTC(2021, 11, 20) / 1000 };
    expect(shardFromInstant(when).month).toBe("12");
  });

  it("derives from UTC, not local time", () => {
    // Both sides of the year boundary: 00:30Z catches negative-offset local
    // zones, 23:30Z catches positive-offset ones — one of the two always
    // discriminates UTC from local regardless of the host's offset sign.
    const justAfter = { epochSeconds: Date.UTC(2021, 0, 1, 0, 30, 0) / 1000 };
    expect(shardFromInstant(justAfter)).toEqual({ year: "2021", month: "01" });
    const justBefore = { epochSeconds: Date.UTC(2020, 11, 31, 23, 30, 0) / 1000 };
    expect(shardFromInstant(justBefore)).toEqual({ year: "2020", month: "12" });
  });
});

describe("normalizeExt", () => {
  it("lowercases and strips a single leading dot", () => {
    expect(normalizeExt("FIT")).toBe("fit");
    expect(normalizeExt(".tcx")).toBe("tcx");
    expect(normalizeExt("gpx")).toBe("gpx");
  });

  it("rejects invalid extensions echoing the original input", () => {
    for (const bad of ["", "fi t", "json.gz", "../etc", "a/b"]) {
      let caught: unknown;
      try {
        normalizeExt(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidArtifactExtensionError);
      expect((caught as Error).message).toBe(`invalid artifact extension: ${bad}`);
    }
  });
});

describe("assertValidAddress", () => {
  it("passes a 64-char lowercase hex string", () => {
    expect(() => assertValidAddress(ADDR)).not.toThrow();
  });

  it("throws on a 63-char string", () => {
    expect(() => assertValidAddress("a".repeat(63))).toThrow(InvalidContentAddressError);
  });

  it("throws on an uppercase hex digit", () => {
    expect(() => assertValidAddress("A" + "a".repeat(63))).toThrow(InvalidContentAddressError);
  });

  it("throws on a non-hex char", () => {
    expect(() => assertValidAddress("g" + "a".repeat(63))).toThrow(InvalidContentAddressError);
  });
});

describe("rel-path builders", () => {
  it("builds artifact / snapshot / quarantine paths", () => {
    expect(artifactRelPath(ADDR, "fit", WHEN)).toBe(`2021/03/${ADDR}.fit`);
    expect(snapshotRelPath(ADDR, WHEN)).toBe(`2021/03/${ADDR}.json.gz`);
    expect(quarantineRelPath(ADDR, "fit")).toBe(`quarantine/${ADDR}.fit`);
    expect(quarantineReasonRelPath(ADDR, "fit")).toBe(`quarantine/${ADDR}.fit.reason.txt`);
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });

  it("rejects a bad address in every builder", () => {
    expect(() => artifactRelPath(BAD_ADDR, "fit", WHEN)).toThrow(InvalidContentAddressError);
    expect(() => snapshotRelPath(BAD_ADDR, WHEN)).toThrow(InvalidContentAddressError);
    expect(() => quarantineRelPath(BAD_ADDR, "fit")).toThrow(InvalidContentAddressError);
  });
});
