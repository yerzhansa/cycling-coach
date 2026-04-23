import { describe, it, expect } from "vitest";
import { isSecretRef, SecretResolutionError } from "../../src/secrets/types.js";

describe("isSecretRef", () => {
  it("accepts minimal shape with no args", () => {
    expect(isSecretRef({ source: "exec", command: "op" })).toBe(true);
  });

  it("accepts shape with string[] args", () => {
    expect(
      isSecretRef({ source: "exec", command: "op", args: ["read", "op://Vault/Item/field"] }),
    ).toBe(true);
  });

  it("rejects wrong source", () => {
    expect(isSecretRef({ source: "env", command: "op" })).toBe(false);
  });

  it("rejects empty command", () => {
    expect(isSecretRef({ source: "exec", command: "" })).toBe(false);
  });

  it("rejects non-array args", () => {
    expect(isSecretRef({ source: "exec", command: "op", args: "read" })).toBe(false);
  });

  it("rejects args with non-string element", () => {
    expect(isSecretRef({ source: "exec", command: "op", args: ["read", 42] })).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(isSecretRef({ source: "exec", command: "op", extra: 1 })).toBe(false);
  });

  it("rejects null", () => {
    expect(isSecretRef(null)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isSecretRef(["exec", "op"])).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isSecretRef("op")).toBe(false);
    expect(isSecretRef(42)).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
  });
});

describe("SecretResolutionError", () => {
  it("preserves code field and message", () => {
    const err = new SecretResolutionError("ENOENT", "nope");
    expect(err.code).toBe("ENOENT");
    expect(err.message).toBe("nope");
    expect(err.name).toBe("SecretResolutionError");
    expect(err).toBeInstanceOf(Error);
  });
});
