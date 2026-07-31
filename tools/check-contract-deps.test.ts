import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkContractManifest,
  findForbiddenImports,
  isAllowedSpecifier,
  main,
} from "./check-contract-deps.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "contract-deps-lint-"));
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

const CLEAN_MANIFEST = `{"name":"x","private":true,"dependencies":{"zod":"^4.3.6"}}`;

interface CapturedRun {
  code: number;
  output: string;
}

function runMain(argv: readonly string[]): CapturedRun {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (msg?: unknown) => {
    lines.push(String(msg));
  };
  console.error = (msg?: unknown) => {
    lines.push(String(msg));
  };
  try {
    return { code: main(argv), output: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe("checkContractManifest — the manifest property", () => {
  it("flags an extra workspace dependency", () => {
    write(
      "package.json",
      `{"name":"x","private":true,"dependencies":{"zod":"^4.3.6","@enduragent/core":"workspace:*"}}`,
    );
    write("src/a.ts", `export const a = 1;\n`);
    const run = runMain([tempDir]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("@enduragent/core");
  });

  it("flags missing zod", () => {
    write("package.json", `{"name":"x","private":true,"dependencies":{}}`);
    write("src/a.ts", `export const a = 1;\n`);
    expect(runMain([tempDir]).code).toBe(1);
  });

  it("flags populated peerDependencies", () => {
    write(
      "package.json",
      `{"name":"x","private":true,"dependencies":{"zod":"^4.3.6"},"peerDependencies":{"react":"^19"}}`,
    );
    write("src/a.ts", `export const a = 1;\n`);
    const run = runMain([tempDir]);
    expect(run.code).toBe(1);
    expect(run.output).toContain("peerDependencies");
  });

  it("flags private missing or false", () => {
    write("package.json", `{"name":"x","dependencies":{"zod":"^4.3.6"}}`);
    write("src/a.ts", `export const a = 1;\n`);
    expect(runMain([tempDir]).code).toBe(1);

    write("package.json", `{"name":"x","private":false,"dependencies":{"zod":"^4.3.6"}}`);
    expect(runMain([tempDir]).code).toBe(1);
  });

  it("flags a missing package.json — a nonexistent dir must fail, never pass vacuously", () => {
    expect(checkContractManifest(join(tempDir, "nope", "package.json"))).toHaveLength(1);
    expect(runMain([join(tempDir, "nope")]).code).toBe(1);
  });
});

describe("findForbiddenImports — the import property", () => {
  it("flags node builtins, prefixed and bare, with line/column", () => {
    const prefixed = `import { readFileSync } from "node:fs";\nexport const a = readFileSync;\n`;
    const file = write("src/a.ts", prefixed);
    const hits = findForbiddenImports([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("node:fs");
    expect(hits[0]!.line).toBe(1);
    expect(hits[0]!.column).toBe(prefixed.indexOf(`"node:fs"`) + 1);

    const bare = write("src/b.ts", `import fs from "fs";\nexport const b = fs;\n`);
    const bareHits = findForbiddenImports([bare]);
    expect(bareHits).toHaveLength(1);
    expect(bareHits[0]!.message).toContain(`"fs"`);
  });

  it("flags a workspace package import", () => {
    const file = write("src/a.ts", `import { LLM } from "@enduragent/core";\nexport const a = LLM;\n`);
    const hits = findForbiddenImports([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("@enduragent/core");
  });

  it("flags a type-only workspace import (a type edge is still a dependency edge)", () => {
    const file = write("src/a.ts", `import type { Config } from "@enduragent/core";\nexport const a: Config | null = null;\n`);
    const hits = findForbiddenImports([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("@enduragent/core");
  });

  it("flags a dynamic import", () => {
    const file = write("src/a.ts", `export const p = await import("node:path");\n`);
    const hits = findForbiddenImports([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("node:path");
  });

  it("flags a require call", () => {
    const file = write(
      "src/a.ts",
      `declare const require: (id: string) => unknown;\nconst fs = require("node:fs");\nexport const a = fs;\n`,
    );
    const hits = findForbiddenImports([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("node:fs");
    expect(hits[0]!.line).toBe(2);
  });

  it("allows relative imports and zod", () => {
    expect(isAllowedSpecifier("zod")).toBe(true);
    expect(isAllowedSpecifier("zod/v4")).toBe(true);
    expect(isAllowedSpecifier("./other.js")).toBe(true);
    expect(isAllowedSpecifier("../src/helper.js")).toBe(true);
    const file = write(
      "src/a.ts",
      `import { z } from "zod";\nexport * from "./other.js";\nimport { helper } from "../src/helper.js";\nexport const a = { z, helper };\n`,
    );
    expect(findForbiddenImports([file])).toHaveLength(0);
  });

  it("respects the skip-file marker", () => {
    const file = write(
      "src/skipped.ts",
      `// contract-deps-lint:skip-file\nimport { readFileSync } from "node:fs";\nexport const a = readFileSync;\n`,
    );
    expect(findForbiddenImports([file])).toHaveLength(0);
  });
});

describe("main", () => {
  it("returns 0 for a clean fixture end-to-end", () => {
    write("package.json", CLEAN_MANIFEST);
    write("src/a.ts", `import { z } from "zod";\nexport const S = z.string();\n`);
    write("src/b.ts", `export * from "./a.js";\n`);
    const run = runMain([tempDir]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("clean");
  });

  it("the committed contract package is green, and the default scan is not vacuous", () => {
    // No args → scans the committed packages/coach-contract from the repo root.
    const run = runMain([]);
    expect(run.code).toBe(0);
    expect(run.output).toContain("packages/coach-contract");
    const count = /(\d+) source file\(s\) scanned/.exec(run.output);
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThanOrEqual(5);
  });
});
