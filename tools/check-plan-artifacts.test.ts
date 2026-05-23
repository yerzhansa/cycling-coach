// plan-artifact-lint:skip-file — synthetic fixtures embed the forbidden
// vocabulary; the file would otherwise flag itself.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findPlanArtifactHits,
  collectScopedFiles,
  main,
  type PlanArtifactHit,
} from "./check-plan-artifacts.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "plan-artifact-lint-"));
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

describe("findPlanArtifactHits — pattern coverage", () => {
  it("flags Wave-N in markdown prose", () => {
    const file = write("a.md", `Done in Wave 2 and Wave-3 and Wave4.\n`);
    const tokens = findPlanArtifactHits([file]).map((h) => h.token);
    expect(tokens).toEqual(["Wave 2", "Wave-3", "Wave4"]);
  });

  it("flags F-IDs including ranges", () => {
    const file = write("b.md", `Ships in F8 (later F8-F11 and F12–F14).\n`);
    const tokens = findPlanArtifactHits([file]).map((h) => h.token).sort();
    expect(tokens).toEqual(["F12–F14", "F8", "F8-F11"].sort());
  });

  it("flags Decision-N, Phase-X, PR-X", () => {
    const file = write(
      "c.md",
      `See Decision 4 from Phase D before PR C lands.\n`,
    );
    const labels = findPlanArtifactHits([file]).map((h) => h.label).sort();
    expect(labels).toEqual(["Decision-N", "PR-X", "Phase-X"]);
  });

  it("flags battle-plan, Reference PRD, architect-final", () => {
    const file = write(
      "d.md",
      `The battle plan and the battle-plan output beat the Reference PRD; see architect-final.\n`,
    );
    const labels = findPlanArtifactHits([file]).map((h) => h.label).sort();
    expect(labels).toEqual([
      "Reference-PRD",
      "architect-final",
      "battle-plan",
      "battle-plan",
    ]);
  });

  it("flags section-11 and section 11", () => {
    const file = write("e.md", `Per section-11 (also: section 11) we copy.\n`);
    const tokens = findPlanArtifactHits([file]).map((h) => h.token);
    expect(tokens).toContain("section-11");
    expect(tokens).toContain("section 11");
  });

  it("flags `issue #N`", () => {
    const file = write("f.md", `Tracked in issue #47 and issue #123.\n`);
    const tokens = findPlanArtifactHits([file]).map((h) => h.token);
    expect(tokens).toEqual(["issue #47", "issue #123"]);
  });
});

describe("findPlanArtifactHits — TS source", () => {
  it("flags plan-artifact tokens inside TS comments and strings alike", () => {
    const file = write(
      "src.ts",
      `// Track issue #47.\nexport const note = "Lands in Wave 2";\nexport const label = "section-11";\n`,
    );
    const labels = findPlanArtifactHits([file]).map((h) => h.label).sort();
    expect(labels).toEqual(["Wave-N", "issue-#N", "section-11"]);
  });
});

describe("findPlanArtifactHits — clean files", () => {
  it("returns empty for compliant prose", () => {
    const file = write(
      "clean.md",
      `# Title\n\nReference upstream sync covers the load-management metrics.\n`,
    );
    expect(findPlanArtifactHits([file])).toEqual([]);
  });

  it("does not match `Wave` without trailing digit (word-boundary check)", () => {
    const file = write("waves.md", `# Waves\n\nThe Waveform analyzer.\n`);
    expect(findPlanArtifactHits([file])).toEqual([]);
  });

  it("does not flag MUST as a partial token match", () => {
    const file = write("must.md", `# Rules\n\nMUST be preserved across compaction.\n`);
    expect(findPlanArtifactHits([file])).toEqual([]);
  });
});

describe("findPlanArtifactHits — markdown fenced code is skipped", () => {
  it("ignores plan-artifact tokens inside fenced blocks", () => {
    const file = write(
      "fenced.md",
      "# Title\n\n```ts\nconst note = \"Wave 2\"; // F8 section-11\n```\n\nClean prose only.\n",
    );
    expect(findPlanArtifactHits([file])).toEqual([]);
  });
});

describe("findPlanArtifactHits — skip directive", () => {
  it("skips a file whose header contains the directive", () => {
    const file = write(
      "skip.ts",
      `// plan-artifact-lint:skip-file — legitimate exception\nexport const x = "Wave 2 section-11";\n`,
    );
    expect(findPlanArtifactHits([file])).toEqual([]);
  });

  it("skips a markdown file with the directive in an HTML comment", () => {
    const file = write(
      "skip.md",
      `<!-- plan-artifact-lint:skip-file -->\n# Plan\n\nWave 2 lands in F8 per section-11.\n`,
    );
    expect(findPlanArtifactHits([file])).toEqual([]);
  });

  it("does NOT skip when directive falls outside the 1 KB header window", () => {
    const filler = "a".repeat(1100);
    const file = write(
      "late.ts",
      `${filler}\n// plan-artifact-lint:skip-file\nexport const tag = "Wave 2";\n`,
    );
    expect(findPlanArtifactHits([file]).length).toBeGreaterThan(0);
  });
});

describe("findPlanArtifactHits — output shape", () => {
  it("returns file/line/column/token/label per hit, sorted by position", () => {
    const file = write(
      "ordered.md",
      `Line one Wave 2.\nLine two section-11.\nLine three issue #47.\n`,
    );
    const hits = findPlanArtifactHits([file]);
    expect(hits).toHaveLength(3);
    expect(hits[0].line).toBe(1);
    expect(hits[1].line).toBe(2);
    expect(hits[2].line).toBe(3);
    expect(hits[0]).toMatchObject({ file, label: "Wave-N", token: "Wave 2" });
    for (const h of hits as PlanArtifactHit[]) {
      expect(h.column).toBeGreaterThan(0);
    }
  });

  it("skips unsupported extensions silently", () => {
    const file = write("data.json", `{ "tag": "Wave 2" }\n`);
    expect(findPlanArtifactHits([file])).toEqual([]);
  });
});

describe("collectScopedFiles — scope coverage", () => {
  it("includes root CONTEXT-MAP.md, CONTRIBUTING.md, and package CONTEXT/SOUL/README plus src/** and tests/**/README.md", () => {
    write("CONTEXT-MAP.md", `# Map\n`);
    write("CONTRIBUTING.md", `# How to contribute\n`);
    write("NOTICE.md", `MIT\n`);
    write("README.md", `# Root\n`);
    write("CHANGELOG.md", `# Root changelog\n`);
    write(".changeset/foo.md", `---\n---\nFoo.\n`);

    write("packages/core/CONTEXT.md", `# Core\n`);
    write("packages/core/CHANGELOG.md", `# Core changelog\n`);
    write("packages/core/src/lib.ts", `export const x = 1;\n`);
    write("packages/core/src/sub/CONTEXT.md", `# Sub\n`);
    write("packages/core/tests/fixtures/README.md", `# Fixtures\n`);
    write("packages/sport-cycling/SOUL.md", `# Soul\n`);
    write("packages/sport-cycling/README.md", `# Readme\n`);

    const files = collectScopedFiles(tempDir).map((p) => p.replace(tempDir + "/", ""));
    expect(files).toContain("CONTEXT-MAP.md");
    expect(files).toContain("CONTRIBUTING.md");
    expect(files).toContain("packages/core/CONTEXT.md");
    expect(files).toContain("packages/core/src/lib.ts");
    expect(files).toContain("packages/core/src/sub/CONTEXT.md");
    expect(files).toContain("packages/core/tests/fixtures/README.md");
    expect(files).toContain("packages/sport-cycling/SOUL.md");
    expect(files).toContain("packages/sport-cycling/README.md");
    // Allowlist surfaces remain OUT of the collector — they're never lintable.
    expect(files).not.toContain("NOTICE.md");
    expect(files).not.toContain("README.md");
    expect(files).not.toContain("CHANGELOG.md");
    expect(files).not.toContain("packages/core/CHANGELOG.md");
    expect(files).not.toContain(".changeset/foo.md");
  });
});

describe("main — exit codes and allowlist", () => {
  it("exits 0 on a clean repo root", () => {
    write("CONTEXT-MAP.md", `# Map\n\nReference layer covers load metrics.\n`);
    write("CONTRIBUTING.md", `# Contributing\n\nUse Fitness / Fatigue / Form.\n`);
    write("packages/core/CONTEXT.md", `# Core\n\nAll good.\n`);
    expect(main([], tempDir)).toBe(0);
  });

  it("exits 1 on a known-failing tree and reports each hit", () => {
    write(
      "CONTRIBUTING.md",
      `# Contributing\n\nSee section-11 and Wave 2 plans.\n`,
    );
    write(
      "packages/core/CONTEXT.md",
      `# Core\n\nLands in F8 (issue #47).\n`,
    );
    const exit = main([], tempDir);
    expect(exit).toBe(1);
  });

  it("does not lint files in the allowlist (root README, NOTICE, .changeset, CHANGELOG)", () => {
    write("NOTICE.md", `Adapted from section-11.\n`);
    write("README.md", `# Root\n\nCredits: section-11.\n`);
    write("CHANGELOG.md", `# Root\n\nWave 2 changelog.\n`);
    write("packages/core/CHANGELOG.md", `# Core\n\nF8 entry.\n`);
    write(".changeset/x.md", `---\n---\nWave 2 fix.\n`);
    expect(main([], tempDir)).toBe(0);
  });
});
