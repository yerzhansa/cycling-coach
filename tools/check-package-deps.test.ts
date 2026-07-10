import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RULES,
  runRulesAgainst,
  checkPrivatePackages,
  matchesEntry,
  packageRoot,
  main,
  type PackageDepRule,
} from "./check-package-deps.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "package-deps-lint-"));
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

function writeJson(rel: string, obj: unknown): string {
  return write(rel, JSON.stringify(obj, null, 2));
}

function ruleForDir(dir: string): PackageDepRule {
  const r = RULES.find((x) => x.dir === dir);
  if (!r) throw new Error(`no rule for ${dir}`);
  return r;
}

function violationsFor(rule: PackageDepRule): number {
  return runRulesAgainst(tempDir, [rule]).violations.length;
}

const r1 = ruleForDir("packages/kernel");
const r2 = ruleForDir("packages/kernel-node");
const rEngine = ruleForDir("packages/engine");
const rCore = ruleForDir("packages/core");
const r4 = ruleForDir("packages/sport-*");
const r5 = ruleForDir("packages/sync-*");
const rRenderer = ruleForDir("apps/desktop-renderer");
const rCoach = ruleForDir("packages/coach");
const rBin = ruleForDir("packages/cycling-coach");

describe("R1 kernel purity", () => {
  it("R1 flags a node: prefixed import", () => {
    write("packages/kernel/src/bad.ts", `import { readFileSync } from "node:fs";\n`);
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a bare Node builtin import", () => {
    write("packages/kernel/src/bad.ts", `import fs from "fs";\n`);
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a require() of a builtin", () => {
    write(
      "packages/kernel/src/bad.ts",
      `declare const require: (m: string) => unknown;\nconst fs = require("node:fs");\nexport const x = fs;\n`,
    );
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a dynamic import of a builtin", () => {
    write(
      "packages/kernel/src/bad.ts",
      `export async function f() {\n  return await import("node:path");\n}\n`,
    );
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags a workspace import (kernel imports nothing)", () => {
    write("packages/kernel/src/bad.ts", `import { z } from "@enduragent/core";\nexport const x = z;\n`);
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 flags an @enduragent dependency in the manifest", () => {
    write("packages/kernel/src/clean.ts", `export const x = 1;\n`);
    writeJson("packages/kernel/package.json", {
      name: "@enduragent/kernel",
      private: true,
      dependencies: { "@enduragent/coach-contract": "workspace:*" },
    });
    expect(violationsFor(r1)).toBe(1);
  });

  it("R1 passes a clean kernel (zod + relative imports)", () => {
    write(
      "packages/kernel/src/clean.ts",
      `import { z } from "zod";\nimport { helper } from "./helper.js";\nexport const x = z ?? helper;\n`,
    );
    write("packages/kernel/src/helper.ts", `export const helper = 1;\n`);
    expect(violationsFor(r1)).toBe(0);
  });
});

describe("R2 kernel-node adapter", () => {
  it("R2 flags importing @enduragent/core", () => {
    write("packages/kernel-node/src/bad.ts", `import { z } from "@enduragent/core";\nexport const x = z;\n`);
    expect(violationsFor(r2)).toBe(1);
  });

  it("R2 passes importing @enduragent/kernel and node:fs (node allowed here)", () => {
    write(
      "packages/kernel-node/src/ok.ts",
      `import { KERNEL_STATUS } from "@enduragent/kernel";\nimport { readFileSync } from "node:fs";\nexport const x = KERNEL_STATUS ?? readFileSync;\n`,
    );
    expect(violationsFor(r2)).toBe(0);
  });
});

describe("R3 engine + core", () => {
  it("R3 flags the engine importing @enduragent/kernel-node", () => {
    write("packages/engine/src/bad.ts", `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`);
    expect(violationsFor(rEngine)).toBe(1);
  });

  it("R3 flags the engine importing @enduragent/core", () => {
    write("packages/engine/src/bad.ts", `import { x } from "@enduragent/core";\nexport const y = x;\n`);
    expect(violationsFor(rEngine)).toBe(1);
  });

  it("R3 passes the engine importing coach-contract + sport-cycling", () => {
    write(
      "packages/engine/src/ok.ts",
      `import { a } from "@enduragent/coach-contract";\nimport { b } from "@enduragent/sport-cycling";\nexport const y = a ?? b;\n`,
    );
    expect(violationsFor(rEngine)).toBe(0);
  });

  it("R3 passes core importing @enduragent/engine but surfaces the transitional WARN", () => {
    write("packages/core/src/shim.ts", `import { e } from "@enduragent/engine";\nexport const y = e;\n`);
    const result = runRulesAgainst(tempDir, [rCore]);
    expect(result.violations).toHaveLength(0);
    expect(result.warnEdges).toContainEqual({ dir: "packages/core", target: "@enduragent/engine" });
  });

  it("R3 flags core importing @enduragent/kernel-node", () => {
    write("packages/core/src/bad.ts", `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`);
    expect(violationsFor(rCore)).toBe(1);
  });
});

describe("R4 sport packages", () => {
  it("R4 flags a sport importing @enduragent/engine (root, not the subpath)", () => {
    write("packages/sport-x/src/bad.ts", `import { e } from "@enduragent/engine";\nexport const y = e;\n`);
    expect(violationsFor(r4)).toBe(1);
  });

  it("R4 passes a sport importing @enduragent/engine/sport (the blessed subpath)", () => {
    write(
      "packages/sport-x/src/ok.ts",
      `import { e } from "@enduragent/engine/sport";\nexport const y = e;\n`,
    );
    expect(violationsFor(r4)).toBe(0);
  });

  it("R4 flags a sport importing @enduragent/kernel-node (the R8 wall)", () => {
    write("packages/sport-x/src/bad.ts", `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`);
    expect(violationsFor(r4)).toBe(1);
  });

  it("R4 passes a sport importing @enduragent/core and surfaces the transitional WARN", () => {
    write("packages/sport-x/src/ok.ts", `import { c } from "@enduragent/core";\nexport const y = c;\n`);
    const result = runRulesAgainst(tempDir, [r4]);
    expect(result.violations).toHaveLength(0);
    expect(result.warnEdges).toContainEqual({ dir: "packages/sport-x", target: "@enduragent/core" });
  });
});

describe("R5 sync packages", () => {
  it("R5 flags a sync package importing @enduragent/core", () => {
    write("packages/sync-x/src/bad.ts", `import { c } from "@enduragent/core";\nexport const y = c;\n`);
    expect(violationsFor(r5)).toBe(1);
  });

  it("R5 passes a sync package importing @enduragent/kernel", () => {
    write("packages/sync-x/src/ok.ts", `import { k } from "@enduragent/kernel";\nexport const y = k;\n`);
    expect(violationsFor(r5)).toBe(0);
  });
});

describe("R6 desktop renderer", () => {
  it("R6 flags the renderer importing @enduragent/engine", () => {
    write("apps/desktop-renderer/src/bad.ts", `import { e } from "@enduragent/engine";\nexport const y = e;\n`);
    expect(violationsFor(rRenderer)).toBe(1);
  });

  it("R6 passes the renderer importing @enduragent/coach-contract", () => {
    write(
      "apps/desktop-renderer/src/ok.ts",
      `import { a } from "@enduragent/coach-contract";\nexport const y = a;\n`,
    );
    expect(violationsFor(rRenderer)).toBe(0);
  });
});

describe("R7 private-package check", () => {
  it("R7 flags an @enduragent package without private:true", () => {
    writeJson("packages/leaky/package.json", { name: "@enduragent/leaky" });
    expect(checkPrivatePackages(tempDir)).toHaveLength(1);
  });

  it("R7 passes an @enduragent package with private:true", () => {
    writeJson("packages/tight/package.json", { name: "@enduragent/tight", private: true });
    expect(checkPrivatePackages(tempDir)).toHaveLength(0);
  });
});

describe("R8 composition root", () => {
  it("R8 passes the composition root importing kernel-node + engine + sync (the meet is legal here)", () => {
    write(
      "packages/coach/src/ok.ts",
      `import { a } from "@enduragent/kernel-node";\nimport { b } from "@enduragent/engine";\nimport { c } from "@enduragent/sync-intervals-icu";\nexport const y = a ?? b ?? c;\n`,
    );
    expect(violationsFor(rCoach)).toBe(0);
  });
});

describe("R-BIN legacy binaries", () => {
  it("R-BIN passes importing @enduragent/core + @enduragent/sport-cycling", () => {
    write(
      "packages/cycling-coach/src/ok.ts",
      `import { c } from "@enduragent/core";\nimport { s } from "@enduragent/sport-cycling";\nexport const y = c ?? s;\n`,
    );
    expect(violationsFor(rBin)).toBe(0);
  });

  it("R-BIN flags importing @enduragent/kernel-node (the new graph is walled off)", () => {
    write("packages/cycling-coach/src/bad.ts", `import { x } from "@enduragent/kernel-node";\nexport const y = x;\n`);
    expect(violationsFor(rBin)).toBe(1);
  });

  it("R-BIN flags importing @enduragent/engine", () => {
    write("packages/cycling-coach/src/bad.ts", `import { e } from "@enduragent/engine";\nexport const y = e;\n`);
    expect(violationsFor(rBin)).toBe(1);
  });
});

describe("skip-file directive", () => {
  it("R1 skips a violating kernel file carrying the skip marker", () => {
    write(
      "packages/kernel/src/skipped.ts",
      `// package-deps-lint:skip-file\nimport { readFileSync } from "node:fs";\nexport const x = readFileSync;\n`,
    );
    expect(violationsFor(r1)).toBe(0);
  });
});

describe("matchers", () => {
  it("root entries allow subpaths; subpath entries never allow the root", () => {
    expect(matchesEntry("@enduragent/kernel", "@enduragent/kernel")).toBe(true);
    expect(matchesEntry("@enduragent/kernel/foo", "@enduragent/kernel")).toBe(true);
    expect(matchesEntry("@enduragent/engine", "@enduragent/engine/sport")).toBe(false);
    expect(matchesEntry("@enduragent/engine/sport", "@enduragent/engine/sport")).toBe(true);
    expect(matchesEntry("@enduragent/sport-cycling/migrate", "@enduragent/sport-*")).toBe(true);
    expect(matchesEntry("@enduragent/sports-foo", "@enduragent/sport-*")).toBe(false);
  });

  it("packageRoot collapses a subpath to the @enduragent/<name> root", () => {
    expect(packageRoot("@enduragent/sport-cycling/migrate")).toBe("@enduragent/sport-cycling");
    expect(packageRoot("@enduragent/core")).toBe("@enduragent/core");
  });
});

describe("real repository", () => {
  it("the committed workspace is clean", () => {
    expect(main([])).toBe(0);
  });

  it("surfaces exactly the five transitional sport edges at branch point (guards a vacuous pass)", () => {
    const result = runRulesAgainst(".", RULES);
    const edges = result.warnEdges.map((e) => `${e.dir} -> ${e.target}`);
    expect(edges).toEqual([
      "packages/sport-cycling -> @enduragent/core",
      "packages/sport-duathlon -> @enduragent/core",
      "packages/sport-duathlon -> @enduragent/sport-cycling",
      "packages/sport-duathlon -> @enduragent/sport-running",
      "packages/sport-running -> @enduragent/core",
    ]);
  });

  it("marks the absent end-state rows not-present (discovery is not vacuous)", () => {
    const result = runRulesAgainst(".", RULES);
    expect(result.notPresent).toContain("packages/engine");
    expect(result.notPresent).toContain("packages/sync-*");
    expect(result.scannedFileCount).toBeGreaterThan(0);
  });
});
