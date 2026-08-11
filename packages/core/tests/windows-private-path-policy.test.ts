import { describe, expect, it } from "vitest";
import {
  WindowsPrivatePathPolicyError,
  assertWindowsPrivatePathBinding,
  assertWindowsPrivatePathEntry,
  assertWindowsPrivatePathRead,
  classifyWindowsPrivatePathDurability,
  classifyWindowsPrivatePathFailure,
} from "../src/io/windows-private-path-policy.js";

function captureFailure(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new TypeError("expected Windows private path failure");
}

describe("Windows private path policy", () => {
  it.each([
    ["content-write", "required"],
    ["file-flush", "required"],
    ["rename", "required"],
    ["directory-sync", "unavailable"],
  ] as const)("classifies %s durability as %s", (stage, kind) => {
    expect(classifyWindowsPrivatePathDurability(stage)).toEqual({ kind });
  });

  it.each(["EBUSY", "EPERM", "EACCES"])("maps %s to a path-free sharing violation", (code) => {
    const privatePath = String.raw`C:\Users\Athlete Name\.enduragent\data\state.json`;
    const failure = classifyWindowsPrivatePathFailure(
      "rename",
      Object.assign(new Error(`cannot replace ${privatePath}`), { code, path: privatePath }),
    );

    expect(failure).toMatchObject({
      name: "WindowsPrivatePathPolicyError",
      message: "Windows private path policy failed",
      stage: "rename",
      category: "sharing-violation",
    });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(privatePath);
    expect(JSON.stringify(failure)).not.toContain(privatePath);
  });

  it("maps other Node failures to a path-free I/O category", () => {
    expect(classifyWindowsPrivatePathFailure("file-flush", { code: "EIO" })).toMatchObject({
      stage: "file-flush",
      category: "io-failure",
    });
  });

  it.each([
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
  ])("classifies an invalid stable-read assertion as corruption", (input) => {
    const failure = captureFailure(() => assertWindowsPrivatePathRead(input));

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
  });

  it("distinguishes entry type and link-shaped failures", () => {
    expect(
      captureFailure(() =>
        assertWindowsPrivatePathEntry({
          expectedType: "file",
          actualType: "directory",
          linkOrReparseShaped: false,
        }),
      ),
    ).toMatchObject({ stage: "entry-check", category: "entry-type" });
    expect(
      captureFailure(() =>
        assertWindowsPrivatePathEntry({
          expectedType: "directory",
          actualType: "other",
          linkOrReparseShaped: true,
        }),
      ),
    ).toMatchObject({ stage: "entry-check", category: "link-reparse-shaped" });
  });

  it("classifies an unstable or unauthenticated binding as corruption", () => {
    expect(
      captureFailure(() =>
        assertWindowsPrivatePathBinding({
          identityStable: false,
          authenticatedHomeBinding: true,
        }),
      ),
    ).toMatchObject({ stage: "binding-check", category: "corruption" });
    expect(
      captureFailure(() =>
        assertWindowsPrivatePathBinding({
          identityStable: true,
          authenticatedHomeBinding: false,
        }),
      ),
    ).toMatchObject({ stage: "binding-check", category: "corruption" });
  });

  it("accepts a bounded stable read bound to the authenticated home", () => {
    expect(() =>
      assertWindowsPrivatePathRead({
        bounded: true,
        identityStable: true,
        contentValid: true,
        authenticatedHomeBinding: true,
      }),
    ).not.toThrow();
  });
});
