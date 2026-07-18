import { describe, expect, it, vi } from "vitest";
import {
  CoachCliSessionStartError,
  DEFAULT_CLI_SESSION_KEY,
  InvalidCoachCliSessionError,
  normalizeNamedSessionKey,
  resolveCoachCliSession,
} from "../src/session-key.js";

describe("CLI session keys", () => {
  it("resolves default, named, trimmed, and case-sensitive keys", () => {
    expect(resolveCoachCliSession({ kind: "default" })).toEqual({
      kind: "default",
      chatId: DEFAULT_CLI_SESSION_KEY,
    });
    expect(resolveCoachCliSession({ kind: "named", key: " RaceA " })).toEqual({
      kind: "named",
      chatId: "cli:RaceA",
    });
    expect(normalizeNamedSessionKey("racea")).toBe("cli:racea");
    expect(normalizeNamedSessionKey("RaceA")).toBe("cli:RaceA");
  });

  it("applies NFC before enforcing the ASCII namespace grammar", () => {
    const decomposed = "e\u0301";
    const composed = "é";
    expect(() => normalizeNamedSessionKey(decomposed)).toThrow(InvalidCoachCliSessionError);
    expect(() => normalizeNamedSessionKey(composed)).toThrow(InvalidCoachCliSessionError);
  });

  it("rejects every invalid named-key boundary with the typed error", () => {
    const invalid = [
      "",
      " ",
      ":escape",
      "a:b",
      ".start",
      "with space",
      "a/b",
      "é",
      "a".repeat(129),
    ];
    for (const raw of invalid) {
      try {
        normalizeNamedSessionKey(raw);
        throw new Error("expected invalid key");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidCoachCliSessionError);
        expect(error).toMatchObject({ kind: "invalid-named-session" });
      }
    }
    expect(normalizeNamedSessionKey("a".repeat(128))).toBe(`cli:${"a".repeat(128)}`);
  });

  it("creates one canonical fresh key without session RPC methods", () => {
    const factory = vi.fn(() => "123e4567-e89b-42d3-a456-426614174000");
    const result = resolveCoachCliSession({ kind: "fresh" }, factory);
    expect(result).toEqual({
      kind: "fresh",
      chatId: "cli:fresh:123e4567-e89b-42d3-a456-426614174000",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(Object.keys(result)).toEqual(["kind", "chatId"]);
  });

  it("collapses throwing and invalid factories to the typed start error", () => {
    for (const factory of [
      () => {
        throw new Error("private cause");
      },
      () => "123E4567-E89B-42D3-A456-426614174000",
      () => "123e4567-e89b-02d3-a456-426614174000",
      () => "not-a-uuid",
    ]) {
      try {
        resolveCoachCliSession({ kind: "fresh" }, factory);
        throw new Error("expected fresh failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CoachCliSessionStartError);
        expect(error).toMatchObject({ kind: "fresh-session-start-failed" });
      }
    }
  });
});
