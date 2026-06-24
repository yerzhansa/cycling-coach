// trademark-lint:skip-file — this test file embeds the forbidden tokens in
// synthetic fixtures and assertions; it would always flag itself otherwise.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findTrademarkHits, type TrademarkHit } from "./check-trademarks.js";
import { collectFiles } from "./lint-fs.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "trademark-lint-"));
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

describe("findTrademarkHits — TypeScript files (AST-walked)", () => {
  it("flags forbidden tokens inside string literals", () => {
    const file = write(
      "sample.ts",
      `export const label = "Athlete CTL trend";\nexport const note = "TSS rising";\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(2);
    expect(hits.map((h: TrademarkHit) => h.token).sort()).toEqual(["CTL", "TSS"]);
    for (const h of hits) {
      expect(h.file).toBe(file);
      expect(h.line).toBeGreaterThan(0);
    }
  });

  it("flags forbidden tokens inside comments", () => {
    const file = write(
      "comment.ts",
      `// Use ATL for fatigue tracking\nexport const x = 1;\n/* TSB band guidance below */\nexport const y = 2;\n`,
    );
    const hits = findTrademarkHits([file]);
    const tokens = hits.map((h: TrademarkHit) => h.token).sort();
    expect(tokens).toEqual(["ATL", "TSB"]);
  });

  it("ignores forbidden tokens that are code identifiers, not strings or comments", () => {
    // The whole point of AST-walking instead of regex: `IF` and `NP` are
    // legal JS identifiers. They should NOT trip the linter when used as
    // identifiers — only when written in user-facing strings or comments.
    const file = write(
      "identifiers.ts",
      `const IF = 1;\nconst NP = "value";\nconst Pacing = { IF: 0.85 };\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(0);
  });

  it("flags `Normalized Power` as a phrase token in strings", () => {
    const file = write("phrase.ts", `export const note = "Includes Normalized Power data";\n`);
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("Normalized Power");
  });

  it("returns each hit with file, line, column, and token", () => {
    const file = write("loc.ts", `export const a = 1;\nexport const note = "CTL";\n`);
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      file,
      line: 2,
      token: "CTL",
    });
    expect(hits[0].column).toBeGreaterThan(0);
  });

  it("avoids word-boundary false positives (`MUST` is not `TSS`)", () => {
    const file = write(
      "boundaries.ts",
      `export const note = "MUST PRESERVE: Athlete identifiers";\nexport const word = "consultsST";\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(0);
  });
});

describe("findTrademarkHits — Markdown files (regex)", () => {
  it("flags forbidden tokens in markdown body text", () => {
    const file = write(
      "doc.md",
      `# Title\n\nWe report CTL and TSS in the dashboard.\nAlso flagged: TSB band.\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const tokens = new Set(hits.map((h: TrademarkHit) => h.token));
    expect(tokens).toContain("CTL");
    expect(tokens).toContain("TSS");
    expect(tokens).toContain("TSB");
  });

  it("ignores forbidden tokens inside fenced code blocks", () => {
    // Code-block contents are technical — the IF / NP / TSS that may appear
    // there are typically code identifiers or test fixtures, not athlete-facing
    // language. The lint should not block PRs on those.
    const file = write(
      "code-block.md",
      "# Title\n\n```ts\nconst IF = 1;\nconst note = \"CTL\"; // raw\n```\n\nNormal text without forbidden tokens.\n",
    );
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(0);
  });

  it("respects word boundaries on markdown (`MUST` is not `TSS`)", () => {
    const file = write("md-boundaries.md", `# Title\n\nMUST be preserved. uplifting.\n`);
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(0);
  });
});

describe("findTrademarkHits — clean files", () => {
  it("returns an empty array for a fully compliant TS file", () => {
    const file = write(
      "clean.ts",
      `// Use Fitness, Fatigue, Form, Load, Intensity (intervals.icu vocabulary).\nexport const tip = "Fitness rising; Fatigue stable; Form positive.";\n`,
    );
    expect(findTrademarkHits([file])).toEqual([]);
  });

  it("returns an empty array for a fully compliant MD file", () => {
    const file = write(
      "clean.md",
      `# Title\n\nWe report Fitness, Fatigue, and Form in the dashboard.\n`,
    );
    expect(findTrademarkHits([file])).toEqual([]);
  });
});

describe("findTrademarkHits — skip directive", () => {
  it("skips a TS file containing `trademark-lint:skip-file` near the top", () => {
    const file = write(
      "skip.ts",
      `// trademark-lint:skip-file — this file legitimately mentions tokens.\nexport const tokens = "CTL ATL TSB";\n`,
    );
    expect(findTrademarkHits([file])).toEqual([]);
  });

  it("skips a markdown file containing the directive in an HTML comment", () => {
    const file = write(
      "skip.md",
      `<!-- trademark-lint:skip-file -->\n# Glossary\n\nCTL, ATL, TSB are TrainingPeaks marks.\n`,
    );
    expect(findTrademarkHits([file])).toEqual([]);
  });

  it("does NOT skip when the directive appears past the 1 KB header window", () => {
    const filler = "a".repeat(1100);
    const file = write(
      "late-skip.ts",
      `${filler}\n// trademark-lint:skip-file\nexport const tag = "CTL";\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("findTrademarkHits — markdown line-level skip", () => {
  it("skips a forbidden token on a `skip-line`-marked line but flags it elsewhere", () => {
    const file = write(
      "line-skip.md",
      `# Substitution table\n\n| TSS | Load | <!-- trademark-lint:skip-line -->\n\nWe still report TSS in the legacy export.\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("TSS");
    // The surviving hit is the un-marked prose line, not the table line.
    expect(hits[0].line).toBe(5);
  });

  it("skips the following line when `skip-next-line` is used", () => {
    const file = write(
      "next-line-skip.md",
      `# Ban list\n\n<!-- trademark-lint:skip-next-line -->\n| CTL | Fitness |\n\nUnmarked CTL mention.\n`,
    );
    const hits = findTrademarkHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("CTL");
    expect(hits[0].line).toBe(6);
  });
});

describe("findTrademarkHits — extended scan scope", () => {
  it("collects and lints `.md` files under a skills-shaped directory", () => {
    const skillFile = write(
      "packages/sport-cycling/skills/zone-reference.md",
      `# Power Zone Reference\n\nWe report TSS on the dashboard.\n`,
    );
    const collected: string[] = [];
    collectFiles(join(tempDir, "packages/sport-cycling/skills"), collected);
    expect(collected).toContain(skillFile);
    const hits = findTrademarkHits(collected);
    expect(hits.map((h: TrademarkHit) => h.token)).toContain("TSS");
  });
});

describe("findTrademarkHits — file selection", () => {
  it("ignores files with unsupported extensions", () => {
    const file = write("not-checked.json", `{ "tag": "CTL" }`);
    expect(findTrademarkHits([file])).toEqual([]);
  });

  it("processes multiple files in one call and aggregates hits", () => {
    const a = write("a.ts", `export const x = "CTL";\n`);
    const b = write("b.md", `Token: TSS\n`);
    const hits = findTrademarkHits([a, b]);
    expect(hits.map((h: TrademarkHit) => h.token).sort()).toEqual(["CTL", "TSS"]);
  });
});
