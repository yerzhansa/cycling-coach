import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectFiles, ext, TS_EXTS, makeSkipCheck, isCliEntry, nonFlagArgs } from "./lint-fs.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lint-fs-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function write(rel: string, contents: string): string {
  const p = join(tempDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, contents, "utf-8");
  return p;
}

describe("collectFiles", () => {
  it("collects nested files, skipping node_modules / dist / dotfile dirs while recursing", () => {
    write("pkg/src/a.ts", "export const a = 1;\n");
    write("pkg/src/sub/b.ts", "export const b = 2;\n");
    write("pkg/node_modules/dep/c.ts", "export const c = 3;\n");
    write("pkg/dist/d.ts", "export const d = 4;\n");
    write("pkg/.cache/e.ts", "export const e = 5;\n");

    const out: string[] = [];
    collectFiles(join(tempDir, "pkg"), out);

    expect(out.some((p) => p.endsWith("a.ts"))).toBe(true);
    expect(out.some((p) => p.endsWith("b.ts"))).toBe(true);
    expect(out.some((p) => p.endsWith("c.ts"))).toBe(false);
    expect(out.some((p) => p.endsWith("d.ts"))).toBe(false);
    expect(out.some((p) => p.endsWith("e.ts"))).toBe(false);
  });

  it("collects a single file passed directly (top-level stat, not a dir walk)", () => {
    const file = write("pkg/src/a.ts", "export const a = 1;\n");
    const out: string[] = [];
    collectFiles(file, out);
    expect(out).toEqual([file]);
  });

  it("silently ignores a missing path", () => {
    const out: string[] = [];
    expect(() => collectFiles(join(tempDir, "nope"), out)).not.toThrow();
    expect(out).toEqual([]);
  });

  it("walks a dotfile dir passed as an explicit top-level arg (the .changeset contract)", () => {
    write(".changeset/x.ts", "export const x = 1;\n");
    const out: string[] = [];
    collectFiles(join(tempDir, ".changeset"), out);
    expect(out.some((p) => p.endsWith("x.ts"))).toBe(true);
  });
});

describe("ext", () => {
  it("returns the dotted extension for normal files and '' for none", () => {
    expect(ext("foo.ts")).toBe(".ts");
    expect(ext("a/b/c.tsx")).toBe(".tsx");
    expect(ext("Makefile")).toBe("");
    expect(ext("a.b.json")).toBe(".json");
  });

  it("treats a leading-dot basename as having no extension (extname semantics)", () => {
    expect(ext(".bashrc")).toBe("");
    expect(ext("dir/.config")).toBe("");
  });
});

describe("TS_EXTS", () => {
  it("carries exactly the four TypeScript source extensions", () => {
    expect([...TS_EXTS].sort()).toEqual([".cts", ".mts", ".ts", ".tsx"]);
  });
});

describe("makeSkipCheck", () => {
  it("detects the directive within the first 1 KB, in any comment style", () => {
    const skip = makeSkipCheck("my-lint:skip-file");
    expect(skip("// my-lint:skip-file\ncode")).toBe(true);
    expect(skip("<!-- my-lint:skip-file -->")).toBe(true);
    expect(skip("clean source")).toBe(false);
  });

  it("does NOT detect a directive past the 1 KB header window", () => {
    const skip = makeSkipCheck("my-lint:skip-file");
    expect(skip("a".repeat(1100) + "\nmy-lint:skip-file")).toBe(false);
  });
});

describe("nonFlagArgs", () => {
  it("strips --flag / -x args and keeps paths", () => {
    expect(nonFlagArgs(["--strict", "packages", "-q", "tools"])).toEqual(["packages", "tools"]);
  });
});

describe("isCliEntry", () => {
  it("returns false for a non-matching meta URL", () => {
    expect(isCliEntry("file:///definitely/not/the/entry.ts")).toBe(false);
  });
});

describe("shared module is token-clean (AC-5)", () => {
  it("carries no gate domain tokens", () => {
    const src = readFileSync(new URL("./lint-fs.ts", import.meta.url), "utf-8");
    expect(src).not.toContain("METRIC_REGISTRY");
    expect(src).not.toMatch(/\bi\d{8,9}\b/);
    expect(src).not.toContain("skip-file");
  });
});
