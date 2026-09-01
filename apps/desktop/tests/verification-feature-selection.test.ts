import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const featureDirectory = resolve(
  repositoryRoot,
  ".agents/skills/verify-enduragent/references/features",
);
const indexSource = readFileSync(resolve(featureDirectory, "README.md"), "utf8");

function featureEntries(): Array<{ label: string; page: string }> {
  return indexSource
    .split("\n")
    .filter(
      (line) =>
        /^\|/.test(line) &&
        !/^\|\s*Feature\s*\|/.test(line) &&
        !/^\|\s*-+\s*\|/.test(line),
    )
    .map((line) => {
      const row = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/.exec(line);
      if (!row) {
        throw new Error(`Invalid feature index row: ${line}`);
      }

      const link = /^\[`[^`]+\.md`\]\(([^)]+\.md)\)/.exec(row[2]);
      if (!link) {
        throw new Error(`Missing local Markdown feature link: ${line}`);
      }

      return { label: row[1], page: link[1] };
    });
}

describe("verification feature catalog", () => {
  it("indexes every local feature page exactly once", () => {
    const entries = featureEntries();
    const labels = entries.map(({ label }) => label);
    const pages = entries.map(({ page }) => page);
    const featurePages = readdirSync(featureDirectory)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort();

    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(pages).size).toBe(pages.length);

    for (const page of pages) {
      expect(page).toBe(basename(page));
      expect(existsSync(resolve(featureDirectory, page))).toBe(true);
    }

    expect([...pages].sort()).toEqual(featurePages);
  });

  it("uses the exact feature page H2 sequence", () => {
    const expectedHeadings = [
      "## Sub-features",
      "## How to get to it (user POV)",
      "## Driving it with verify-enduragent",
      "## Gotchas",
    ];

    for (const { page } of featureEntries()) {
      const source = readFileSync(resolve(featureDirectory, page), "utf8");
      expect(source.match(/^## .+$/gm) ?? [], page).toEqual(expectedHeadings);
    }
  });
});
