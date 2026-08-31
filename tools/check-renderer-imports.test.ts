import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRendererImportViolations, main } from "./check-renderer-imports.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "renderer-imports-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function write(relativePath: string, contents: string): string {
  const path = join(tempDir, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("findRendererImportViolations", () => {
  it("flags static, dynamic, exported, and type imports that target TypeScript files", () => {
    write("src/value.ts", "export const value = 1;\n");
    write("src/view.tsx", "export type View = string;\n");
    const importer = write(
      "src/importer.ts",
      [
        'import { value } from "./value.js";',
        'import type { View } from "./view.js";',
        'export { value as exported } from "./value.js";',
        'export const loaded = import("./value.js");',
        'export type Loaded = import("./view.js").View;',
        'export const raw = import("./value.js?raw");',
      ].join("\n"),
    );

    const violations = findRendererImportViolations([importer]);
    expect(violations).toHaveLength(6);
    expect(violations.map((violation) => violation.replacement)).toEqual([
      "./value",
      "./view",
      "./value",
      "./value",
      "./view",
      "./value?raw",
    ]);
  });

  it("preserves real extensions and unresolved JavaScript specifiers", () => {
    write("src/styles.css", "body {}\n");
    write("src/version.mjs", "export const version = '1';\n");
    write("src/legacy.js", "export const legacy = true;\n");
    const importer = write(
      "src/importer.ts",
      [
        'import "./styles.css";',
        'import { version } from "./version.mjs";',
        'import { legacy } from "./legacy.js";',
        'import { missing } from "./missing.js";',
      ].join("\n"),
    );

    expect(findRendererImportViolations([importer])).toHaveLength(0);
  });

  it("accepts extensionless relative imports", () => {
    write("src/value.ts", "export const value = 1;\n");
    const importer = write("src/importer.ts", 'import { value } from "./value";\n');
    expect(findRendererImportViolations([importer])).toHaveLength(0);
  });
});

describe("main", () => {
  it("scans the whole renderer package and fails on a test import", () => {
    write("apps/desktop-renderer/src/value.ts", "export const value = 1;\n");
    write(
      "apps/desktop-renderer/tests/value.test.ts",
      'import { value } from "../src/value.js";\n',
    );
    expect(main([tempDir])).toBe(1);
  });

  it("passes the committed renderer package with a non-vacuous scan", () => {
    expect(main([])).toBe(0);
  });

  it("does not apply the renderer convention to the Desktop package", () => {
    write("apps/desktop-renderer/src/value.ts", "export const value = 1;\n");
    write("apps/desktop/src/value.ts", "export const value = 1;\n");
    write("apps/desktop/src/importer.ts", 'import { value } from "./value.js";\n');
    expect(main([tempDir])).toBe(0);
  });
});
