import { describe, expect, it } from "vitest";
import {
  classifyPrivatePathDurability,
  classifyPrivatePathErrorCode,
  decidePrivatePathBinding,
  decidePrivatePathEntry,
  decidePrivatePathRead,
  decidePrivatePathRoot,
} from "../src/ports/private-path-policy.js";
import type { PrivatePathPolicyErrorCategory } from "../src/ports/private-path-policy.js";

describe("private path policy", () => {
  it.each([
    ["posix", "content-write", "required"],
    ["posix", "file-flush", "required"],
    ["posix", "rename", "required"],
    ["posix", "directory-sync", "required"],
    ["windows", "content-write", "required"],
    ["windows", "file-flush", "required"],
    ["windows", "rename", "required"],
    ["windows", "directory-sync", "unavailable"],
  ] as const)("classifies %s %s durability as %s", (platform, stage, kind) => {
    expect(classifyPrivatePathDurability({ platform, stage })).toEqual({ kind });
  });

  it.each(["EBUSY", "EPERM", "EACCES"])("classifies %s as a sharing violation", (code) => {
    expect(classifyPrivatePathErrorCode(code)).toBe("sharing-violation");
  });

  it.each(["ENOENT", "EIO", "ebusy", "", undefined, null, 0])(
    "classifies every other error code as an I/O failure",
    (code) => {
      expect(classifyPrivatePathErrorCode(code)).toBe("io-failure");
    },
  );

  it.each([
    ["file", "file"],
    ["directory", "directory"],
  ] as const)("accepts an ordinary %s entry when %s is expected", (actualType, expectedType) => {
    expect(
      decidePrivatePathEntry({ actualType, expectedType, linkOrReparseShaped: false }),
    ).toEqual({ kind: "accept" });
  });

  it.each([
    ["file", "directory"],
    ["directory", "file"],
    ["other", "file"],
  ] as const)("rejects an ordinary %s entry when %s is expected", (actualType, expectedType) => {
    expect(
      decidePrivatePathEntry({ actualType, expectedType, linkOrReparseShaped: false }),
    ).toEqual({ kind: "reject", category: "entry-type" });
  });

  it("gives a link or reparse-shaped entry precedence over an entry-type mismatch", () => {
    expect(
      decidePrivatePathEntry({
        actualType: "other",
        expectedType: "directory",
        linkOrReparseShaped: true,
      }),
    ).toEqual({ kind: "reject", category: "link-reparse-shaped" });
  });

  it.each([
    [true, true, "accept", undefined],
    [false, true, "reject", "corruption"],
    [true, false, "reject", "corruption"],
    [false, false, "reject", "corruption"],
  ] as const)(
    "decides stable=%s authenticated=%s bindings",
    (identityStable, authenticatedHomeBinding, kind, category) => {
      expect(decidePrivatePathBinding({ identityStable, authenticatedHomeBinding })).toEqual(
        category === undefined ? { kind } : { kind, category },
      );
    },
  );

  it("accepts only an ordinary, stable, authenticated root", () => {
    expect(
      decidePrivatePathRoot({
        ordinary: true,
        identityStable: true,
        authenticatedHomeBinding: true,
      }),
    ).toEqual({ kind: "accept" });

    for (const input of [
      { ordinary: false, identityStable: true, authenticatedHomeBinding: true },
      { ordinary: true, identityStable: false, authenticatedHomeBinding: true },
      { ordinary: true, identityStable: true, authenticatedHomeBinding: false },
      { ordinary: false, identityStable: false, authenticatedHomeBinding: false },
    ]) {
      expect(decidePrivatePathRoot(input)).toEqual({ kind: "reject", category: "corruption" });
    }
  });

  it("accepts only a bounded, stable, valid, authenticated read", () => {
    expect(
      decidePrivatePathRead({
        bounded: true,
        identityStable: true,
        contentValid: true,
        authenticatedHomeBinding: true,
      }),
    ).toEqual({ kind: "accept" });

    for (const input of [
      {
        bounded: false,
        identityStable: true,
        contentValid: true,
        authenticatedHomeBinding: true,
      },
      {
        bounded: true,
        identityStable: false,
        contentValid: true,
        authenticatedHomeBinding: true,
      },
      {
        bounded: true,
        identityStable: true,
        contentValid: false,
        authenticatedHomeBinding: true,
      },
      {
        bounded: true,
        identityStable: true,
        contentValid: true,
        authenticatedHomeBinding: false,
      },
    ]) {
      expect(decidePrivatePathRead(input)).toEqual({ kind: "reject", category: "corruption" });
    }
  });

  it("exposes the complete error-category taxonomy", () => {
    const categories = [
      "corruption",
      "sharing-violation",
      "entry-type",
      "link-reparse-shaped",
      "io-failure",
    ] satisfies readonly PrivatePathPolicyErrorCategory[];

    expect(categories).toHaveLength(5);
  });
});
