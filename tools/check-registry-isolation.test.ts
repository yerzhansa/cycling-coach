// registry-isolation-lint:skip-file — this test embeds the guarded identifier in
// synthetic fixtures and assertions.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSportPackageDirs,
  findRegistryReferences,
  main,
} from "./check-registry-isolation.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "registry-isolation-lint-"));
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

describe("findRegistryReferences — code references (AST-walked)", () => {
  it("flags a named import of the registry", () => {
    const file = write(
      "adapter.ts",
      `import { METRIC_REGISTRY } from "../../core/src/reference/metrics/registry.js";\n`,
    );
    const hits = findRegistryReferences([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file).toBe(file);
    expect(hits[0]!.line).toBe(1);
  });

  it("flags an aliased import (the original name still surfaces)", () => {
    const file = write(
      "adapter.ts",
      `import { METRIC_REGISTRY as R } from "x";\nexport const k = Object.keys(R);\n`,
    );
    const hits = findRegistryReferences([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(1);
  });

  it("flags direct usage and mutation", () => {
    const file = write(
      "use.ts",
      `declare const METRIC_REGISTRY: Record<string, { compute: () => unknown }>;\n` +
        `export const keys = Object.keys(METRIC_REGISTRY);\n` +
        `METRIC_REGISTRY["dfa_a1"] = { compute: () => null };\n`,
    );
    const hits = findRegistryReferences([file]);
    expect(hits).toHaveLength(3);
  });

  it("flags namespaced member access", () => {
    const file = write(
      "ns.ts",
      `import * as registry from "x";\nexport const k = registry.METRIC_REGISTRY;\n`,
    );
    const hits = findRegistryReferences([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
  });

  it("flags references in every declared TS extension, not just .ts", () => {
    const tsx = write("a.tsx", `export const k = METRIC_REGISTRY;\n`);
    const mts = write("b.mts", `export const k = METRIC_REGISTRY;\n`);
    const cts = write("c.cts", `export const k = METRIC_REGISTRY;\n`);
    expect(findRegistryReferences([tsx])).toHaveLength(1);
    expect(findRegistryReferences([mts])).toHaveLength(1);
    expect(findRegistryReferences([cts])).toHaveLength(1);
  });
});

describe("findRegistryReferences — precision (only code, never prose)", () => {
  it("does NOT flag the identifier inside strings or comments", () => {
    const file = write(
      "prose.ts",
      `// We delegate instead of touching METRIC_REGISTRY directly.\n` +
        `export const note = "computes are owned by METRIC_REGISTRY in core";\n`,
    );
    expect(findRegistryReferences([file])).toHaveLength(0);
  });

  it("does NOT flag a clean adapter that delegates via the public compute", () => {
    const file = write(
      "clean.ts",
      `import { computePowerCurveDelta } from "@enduragent/core";\n` +
        `export const project = () => computePowerCurveDelta([]);\n`,
    );
    expect(findRegistryReferences([file])).toHaveLength(0);
  });

  it("respects the skip-file marker", () => {
    const file = write(
      "skipped.ts",
      `// registry-isolation-lint:skip-file\nexport const k = METRIC_REGISTRY;\n`,
    );
    expect(findRegistryReferences([file])).toHaveLength(0);
  });

  it("ignores non-TypeScript files", () => {
    const file = write("data.json", `{ "note": "METRIC_REGISTRY" }\n`);
    expect(findRegistryReferences([file])).toHaveLength(0);
  });
});

describe("main", () => {
  it("returns 1 and reports each hit when a sport file references the registry", () => {
    write("packages/sport-x/src/bad.ts", `export const k = METRIC_REGISTRY;\n`);
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    try {
      expect(main([join(tempDir, "packages")])).toBe(1);
    } finally {
      console.error = orig;
    }
    expect(errors.join("\n")).toContain("forbidden");
  });

  it("returns 0 when the scanned scope is clean", () => {
    write("packages/sport-x/src/ok.ts", `export const k = 1;\n`);
    expect(main([join(tempDir, "packages")])).toBe(0);
  });

  it("skips node_modules, dist, and dotfile dirs while walking a package tree", () => {
    // Each excluded dir carries a violation that MUST NOT be reported; only the
    // src file is in scope and it is clean. Pins the load-bearing exclusion.
    write("packages/sport-x/node_modules/dep/bad.ts", `export const k = METRIC_REGISTRY;\n`);
    write("packages/sport-x/dist/out.ts", `export const k = METRIC_REGISTRY;\n`);
    write("packages/sport-x/.cache/hidden.ts", `export const k = METRIC_REGISTRY;\n`);
    write("packages/sport-x/src/ok.ts", `export const clean = 1;\n`);
    expect(main([join(tempDir, "packages")])).toBe(0);
  });

  it("treats an empty or nonexistent scope as a clean pass", () => {
    expect(main([join(tempDir, "does-not-exist")])).toBe(0);
  });

  it("strips flag-style args and still scans the remaining path", () => {
    write("packages/sport-x/src/bad.ts", `export const k = METRIC_REGISTRY;\n`);
    const orig = console.error;
    console.error = () => {};
    try {
      expect(main(["--strict", join(tempDir, "packages")])).toBe(1);
    } finally {
      console.error = orig;
    }
  });
});

describe("real sport packages", () => {
  it("the committed sport packages are clean", () => {
    // No args → discovers every packages/sport-* dir from the repo root.
    expect(main([])).toBe(0);
  });

  it("discovers every committed sport package (guards against a vacuous pass)", () => {
    // Without this, `main([])` above would pass green even if discovery silently
    // matched nothing (renamed/moved packages).
    const dirs = discoverSportPackageDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    expect(dirs.some((d) => d.endsWith("sport-cycling"))).toBe(true);
  });
});
