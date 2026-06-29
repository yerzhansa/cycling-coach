import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Docker image supply-chain guards", () => {
  it("pins every Dockerfile base image by digest", () => {
    const dockerfile = readFileSync(
      resolve(repoRoot, "packages/cycling-coach/Dockerfile"),
      "utf8",
    );
    const fromLines = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("FROM "));

    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/);
    }
  });

  it("keeps Dependabot watching the cycling-coach Dockerfile", () => {
    const dependabot = YAML.parse(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    ) as { updates?: Array<Record<string, unknown>> };

    expect(
      dependabot.updates?.some(
        (entry) =>
          entry["package-ecosystem"] === "docker" &&
          entry.directory === "/packages/cycling-coach",
      ),
    ).toBe(true);
  });
});
