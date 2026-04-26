import { describe, it, expect, afterEach } from "vitest";
import {
  _resolveSecretRefWithOverrides,
  resolveSecretRef,
} from "../../src/secrets/resolve.js";
import { SecretResolutionError } from "../../src/secrets/types.js";

describe("resolveSecretRef", () => {
  it("resolves printf 'hello' to 'hello'", async () => {
    const result = await resolveSecretRef({
      source: "exec",
      command: "printf",
      args: ["hello"],
    });
    expect(result).toBe("hello");
  });

  it("trims single trailing LF", async () => {
    const result = await resolveSecretRef({
      source: "exec",
      command: "printf",
      args: ["hello\n"],
    });
    expect(result).toBe("hello");
  });

  it("trims trailing CRLF (no stray \\r glued to the secret)", async () => {
    const result = await resolveSecretRef({
      source: "exec",
      command: "printf",
      args: ["hello\r\n"],
    });
    expect(result).toBe("hello");
  });

  it("throws EMPTY for empty stdout", async () => {
    const err = await resolveSecretRef({
      source: "exec",
      command: "printf",
      args: [""],
    }).catch((e) => e as SecretResolutionError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("EMPTY");
  });

  it("throws EMPTY for newline-only stdout", async () => {
    const err = await resolveSecretRef({
      source: "exec",
      command: "printf",
      args: ["\n"],
    }).catch((e) => e as SecretResolutionError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("EMPTY");
  });

  it("throws EXIT_NONZERO with stderr tail in message", async () => {
    const err = await resolveSecretRef({
      source: "exec",
      command: "sh",
      args: ["-c", "echo boom >&2; exit 2"],
    }).catch((e) => e as SecretResolutionError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("EXIT_NONZERO");
    expect(err.message).toContain("boom");
    expect(err.message).toContain("2");
  });

  it("throws ENOENT for missing binary", async () => {
    const err = await resolveSecretRef({
      source: "exec",
      command: "definitely-not-a-real-binary-xyz",
    }).catch((e) => e as SecretResolutionError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("ENOENT");
    expect(err.message).toContain("$PATH");
  });

  it("throws TIMEOUT with 200ms override + sleep 60", async () => {
    const err = await _resolveSecretRefWithOverrides(
      { source: "exec", command: "sleep", args: ["60"] },
      { timeoutMs: 200 },
    ).catch((e) => e as SecretResolutionError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("TIMEOUT");
  });

  it("throws OVERFLOW with low maxBytes + yes", async () => {
    const err = await _resolveSecretRefWithOverrides(
      { source: "exec", command: "yes" },
      { maxBytes: 100, timeoutMs: 2000 },
    ).catch((e) => e as SecretResolutionError);
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("OVERFLOW");
  });

  it("shell:false — ';' and '|' args are literal, not shell-interpreted", async () => {
    const result = await resolveSecretRef({
      source: "exec",
      command: "echo",
      args: [";", "rm", "-rf", "~"],
    });
    expect(result).toBe("; rm -rf ~");
  });
});

describe("resolveSecretRef — env source", () => {
  const ENV_VAR = "__CC_TEST_ENV_SECRET__";

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("resolves env var to its value", async () => {
    process.env[ENV_VAR] = "env-value";
    const result = await resolveSecretRef({ source: "env", var: ENV_VAR });
    expect(result).toBe("env-value");
  });

  it("preserves whitespace and trailing newlines (no trimming)", async () => {
    process.env[ENV_VAR] = "  spaced  \n";
    const result = await resolveSecretRef({ source: "env", var: ENV_VAR });
    expect(result).toBe("  spaced  \n");
  });

  it("throws ENOENT when var is unset", async () => {
    delete process.env[ENV_VAR];
    const err = await resolveSecretRef({ source: "env", var: ENV_VAR }).catch(
      (e) => e as SecretResolutionError,
    );
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("ENOENT");
    expect(err.message).toContain(ENV_VAR);
  });

  it("throws EMPTY when var is set to ''", async () => {
    process.env[ENV_VAR] = "";
    const err = await resolveSecretRef({ source: "env", var: ENV_VAR }).catch(
      (e) => e as SecretResolutionError,
    );
    expect(err).toBeInstanceOf(SecretResolutionError);
    expect(err.code).toBe("EMPTY");
    expect(err.message).toContain(ENV_VAR);
  });

  it("never spawns a process — works without /usr/bin/env on PATH", async () => {
    process.env[ENV_VAR] = "no-spawn";
    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await resolveSecretRef({ source: "env", var: ENV_VAR });
      expect(result).toBe("no-spawn");
    } finally {
      process.env.PATH = origPath;
    }
  });
});
