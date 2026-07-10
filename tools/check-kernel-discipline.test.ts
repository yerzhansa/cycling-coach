import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findKernelDisciplineHits, zoneOf, main } from "./check-kernel-discipline.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kernel-discipline-lint-"));
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

describe("R9 intra-kernel wall", () => {
  it("R9 flags a streams file importing into reference", () => {
    const file = write(
      "packages/kernel/src/streams/wbal.ts",
      `import { metric } from "../reference/metrics/x.js";\nexport const y = metric;\n`,
    );
    expect(findKernelDisciplineHits([file])).toHaveLength(1);
  });

  it("R9 passes a streams file importing into numerics (the blessed seam)", () => {
    const file = write(
      "packages/kernel/src/streams/wbal.ts",
      `import { sum } from "../numerics/sum.js";\nexport const y = sum;\n`,
    );
    expect(findKernelDisciplineHits([file])).toHaveLength(0);
  });

  it("R9 flags a reference file importing into streams", () => {
    const file = write(
      "packages/kernel/src/reference/metrics/x.ts",
      `import { wbal } from "../../streams/wbal.js";\nexport const y = wbal;\n`,
    );
    expect(findKernelDisciplineHits([file])).toHaveLength(1);
  });

  it("R9 flags a models file importing into reference", () => {
    const file = write(
      "packages/kernel/src/models/pmc.ts",
      `import { schema } from "../reference/schemas/y.js";\nexport const z = schema;\n`,
    );
    expect(findKernelDisciplineHits([file])).toHaveLength(1);
  });

  it("R9 catches the wall in the kernel test tree too", () => {
    write(
      "packages/kernel/tests/streams/wbal.test.ts",
      `import { metric } from "../../src/reference/metrics/x.js";\nexport const y = metric;\n`,
    );
    // The resolved target lands under reference/, so the tests-tree file is caught.
    expect(main([tempDir])).toBe(1);
  });

  it("R9 passes a clean kernel tree", () => {
    write(
      "packages/kernel/src/streams/wbal.ts",
      `import { sum } from "../numerics/sum.js";\nexport const y = sum;\n`,
    );
    write("packages/kernel/src/numerics/sum.ts", `export const sum = 1;\n`);
    write(
      "packages/kernel/src/reference/metrics/x.ts",
      `import { sum } from "../../numerics/sum.js";\nexport const metric = sum;\n`,
    );
    expect(main([tempDir])).toBe(0);
  });

  it("R9 exits 0 with a not-present note when streams/models are absent", () => {
    write("packages/kernel/src/index.ts", `export const KERNEL_STATUS = "scaffold";\n`);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => {
      logs.push(String(msg));
    };
    try {
      expect(main([tempDir])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logs.some((l) => l.includes("streams") && l.includes("not present yet"))).toBe(true);
    expect(logs.some((l) => l.includes("models") && l.includes("not present yet"))).toBe(true);
  });
});

describe("zoneOf", () => {
  it("classifies by the first zone path segment", () => {
    expect(zoneOf("/a/packages/kernel/src/streams/wbal.ts")).toBe("streams");
    expect(zoneOf("/a/packages/kernel/src/reference/metrics/x.ts")).toBe("reference");
    expect(zoneOf("/a/packages/kernel/src/numerics/sum.ts")).toBe("numerics");
    expect(zoneOf("/a/packages/kernel/src/index.ts")).toBeNull();
  });
});

describe("real repository", () => {
  it("the committed kernel is clean", () => {
    expect(main([])).toBe(0);
  });
});
