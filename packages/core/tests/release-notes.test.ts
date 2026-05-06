import { describe, expect, it } from "vitest";

import { parseRepoFromUrl, parseUserFacing } from "../src/release-notes.js";

describe("parseRepoFromUrl", () => {
  it("parses git+https URL with .git suffix", () => {
    expect(parseRepoFromUrl("git+https://github.com/foo/bar.git")).toEqual({ owner: "foo", name: "bar" });
  });

  it("parses ssh URL", () => {
    expect(parseRepoFromUrl("git@github.com:foo/bar.git")).toEqual({ owner: "foo", name: "bar" });
  });

  it("parses bare https URL without .git", () => {
    expect(parseRepoFromUrl("https://github.com/foo/bar")).toEqual({ owner: "foo", name: "bar" });
  });

  it("ignores trailing #readme fragment", () => {
    expect(parseRepoFromUrl("https://github.com/foo/bar#readme")).toEqual({ owner: "foo", name: "bar" });
  });

  it("returns null for non-GitHub host", () => {
    expect(parseRepoFromUrl("https://gitlab.com/foo/bar.git")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseRepoFromUrl("not-a-url")).toBeNull();
  });
});

describe("parseUserFacing", () => {
  it("extracts a single user-facing line and drops the changeset hash prefix", () => {
    const body = "- abc1234: User-facing: Added /review command.\n\n  Engineering: stuff.";
    expect(parseUserFacing(body)).toEqual(["Added /review command."]);
  });

  it("extracts multiple user-facing lines", () => {
    const body = [
      "- abc: User-facing: First change.",
      "- def: User-facing: Second change.",
    ].join("\n");
    expect(parseUserFacing(body)).toEqual(["First change.", "Second change."]);
  });

  it("returns empty when no user-facing lines exist", () => {
    expect(parseUserFacing("- abc: Pure infra change.\n\n  Engineering details only.")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const body = "user-facing: lowercase works.\nUSER-FACING: caps works.";
    expect(parseUserFacing(body)).toEqual(["lowercase works.", "caps works."]);
  });

  it("trims surrounding whitespace from the captured text", () => {
    expect(parseUserFacing("User-facing:    padded value   ")).toEqual(["padded value"]);
  });

  it("matches when the line is indented inside a sub-bullet", () => {
    const body = "  - User-facing: Indented entry.";
    expect(parseUserFacing(body)).toEqual(["Indented entry."]);
  });

  it("ignores empty captures", () => {
    expect(parseUserFacing("User-facing:\nUser-facing: real one.")).toEqual(["real one."]);
  });
});
