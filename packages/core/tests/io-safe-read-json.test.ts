import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { safeReadJson } from "../src/io/safe-read-json.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ref-safe-read-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const PayloadSchema = z
  .object({
    name: z.string(),
    count: z.number(),
  })
  .strict();

describe("safeReadJson — happy path", () => {
  it("returns the parsed value when file content matches the schema", () => {
    const target = join(tempDir, "ok.json");
    writeFileSync(target, JSON.stringify({ name: "Reference", count: 3 }), "utf-8");

    const result = safeReadJson(target, PayloadSchema);

    expect(result).toEqual({ name: "Reference", count: 3 });
  });
});

describe("safeReadJson — missing-file (ENOENT)", () => {
  it("returns null without logging a warn (missing-is-normal)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = safeReadJson(join(tempDir, "does-not-exist.json"), PayloadSchema);

    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("safeReadJson — corrupt content", () => {
  it("returns null and logs a single warn on JSON syntax error", () => {
    const target = join(tempDir, "broken.json");
    writeFileSync(target, "{ this is not json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = safeReadJson(target, PayloadSchema);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("broken.json");
  });

  it("returns null and logs a single warn on Zod validation failure", () => {
    const target = join(tempDir, "wrong-shape.json");
    writeFileSync(target, JSON.stringify({ name: "Reference", count: "three" }), "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = safeReadJson(target, PayloadSchema);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("wrong-shape.json");
  });

  it("returns null and logs a single warn when the schema's strict() catches an extra field", () => {
    const target = join(tempDir, "extra-field.json");
    writeFileSync(
      target,
      JSON.stringify({ name: "Reference", count: 3, surprise: "field" }),
      "utf-8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = safeReadJson(target, PayloadSchema);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("safeReadJson — IO permission error", () => {
  it("returns null and logs a warn on EACCES (instead of throwing)", () => {
    // Skip on platforms where we can't reliably revoke read perms.
    if (process.platform === "win32") return;
    const target = join(tempDir, "no-read.json");
    writeFileSync(target, JSON.stringify({ name: "Reference", count: 3 }), "utf-8");
    chmodSync(target, 0o000);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result: unknown;
    try {
      result = safeReadJson(target, PayloadSchema);
    } finally {
      // Restore mode so afterEach can clean up.
      chmodSync(target, 0o644);
    }

    // Running under a privileged user (CI sometimes runs as root) bypasses
    // chmod 0o000; in that case, the read succeeds and the result is the
    // parsed object — not an error. We tolerate either outcome here, but
    // assert no THROW. The point of the test is "doesn't throw on EACCES."
    expect(result === null || (typeof result === "object" && result !== null)).toBe(true);
    if (result === null) {
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});
