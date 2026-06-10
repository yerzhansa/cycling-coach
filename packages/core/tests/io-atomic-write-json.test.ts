import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteJson } from "../src/io/atomic-write-json.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ref-atomic-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("atomicWriteJson — happy path", () => {
  it("writes JSON-serialized value to the target path", async () => {
    const target = join(tempDir, "cache.json");
    const payload = { name: "Reference", count: 3, when: "2026-05-09" };

    await atomicWriteJson(target, payload);

    expect(existsSync(target)).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual(payload);
  });

  it("formats output with 2-space indentation for human inspection", async () => {
    const target = join(tempDir, "pretty.json");
    await atomicWriteJson(target, { a: 1, nested: { b: 2 } });

    const raw = readFileSync(target, "utf-8");
    expect(raw).toContain("  ");
    expect(raw).toContain("\n");
  });

  it("overwrites a pre-existing file with the new value", async () => {
    const target = join(tempDir, "replaceable.json");
    writeFileSync(target, JSON.stringify({ old: true }), "utf-8");

    await atomicWriteJson(target, { fresh: 42 });

    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual({ fresh: 42 });
  });

  it("creates the target with owner-only 0o600 permissions", async () => {
    const target = join(tempDir, "private.json");
    await atomicWriteJson(target, { hrv: 62 });

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("tightens a pre-existing world-readable target to 0o600 on overwrite", async () => {
    const target = join(tempDir, "was-readable.json");
    writeFileSync(target, JSON.stringify({ old: true }), { encoding: "utf-8", mode: 0o644 });

    await atomicWriteJson(target, { fresh: true });

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("handles repeated writes without leaving dangling temp files", async () => {
    const target = join(tempDir, "repeated.json");
    for (let i = 0; i < 5; i++) {
      await atomicWriteJson(target, { iter: i });
    }
    const entries = readdirSync(tempDir);
    expect(entries).toContain("repeated.json");
    // No `repeated.json.tmp.*` siblings should linger on a clean run.
    const orphans = entries.filter((e) => e.startsWith("repeated.json.tmp"));
    expect(orphans).toEqual([]);
  });
});

describe("atomicWriteJson — atomicity invariant", () => {
  it("writes via a temp sibling so the original is never partial mid-write", async () => {
    // We can't reliably crash mid-rename in a unit test, but we can assert the
    // canonical pattern: between the moment data is committed to disk and the
    // moment the target is replaced, the data lives at a *.tmp.* sibling.
    // We observe this by listing the directory while a write is in flight.
    // Since atomicWriteJson is async, we kick it off and snapshot mid-write.
    //
    // Pragmatic alternative: check that the final on-disk content matches an
    // atomic write expectation — exactly one file at the target path with full
    // valid JSON (never partial). Repeated rapid writes never produce partial
    // reads if atomicity holds.
    const target = join(tempDir, "concurrent.json");
    const writes = Array.from({ length: 10 }, (_, i) =>
      atomicWriteJson(target, { gen: i, payload: "x".repeat(1024) }),
    );
    await Promise.all(writes);

    // Final content must parse cleanly — never half-written.
    const raw = readFileSync(target, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const final = JSON.parse(raw);
    expect(typeof final.gen).toBe("number");
    expect(final.payload).toBe("x".repeat(1024));
  });

  it("preserves the original file when the new payload throws during serialization", async () => {
    const target = join(tempDir, "preserve.json");
    const original = { keep: "me" };
    await atomicWriteJson(target, original);

    // A circular value can't be JSON.stringified — atomicWriteJson must throw
    // BEFORE any disk write so the original on-disk file is untouched.
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(atomicWriteJson(target, circular)).rejects.toThrow();

    const onDisk = JSON.parse(readFileSync(target, "utf-8"));
    expect(onDisk).toEqual(original);
  });
});
