import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("Dockerfile base-image pin guard", () => {
  it("every FROM pins an image digest", () => {
    const dockerfile = readFileSync(resolve(HERE, "../Dockerfile"), "utf-8");
    const fromLines = dockerfile.split("\n").filter((line) => /^FROM\s/i.test(line));
    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      expect(
        /@sha256:[0-9a-f]{64}(?:\s|$)/i.test(line),
        `Unpinned base image in Dockerfile:\n  ${line}\n` +
          `Pin the image to a digest using the \`image:tag@sha256:...\` form so a ` +
          `mutable tag can't silently change the build.`,
      ).toBe(true);
    }
  });

  it("dependabot tracks the Dockerfile directory", () => {
    const yaml = readFileSync(resolve(HERE, "../../../.github/dependabot.yml"), "utf-8");
    const config = parse(yaml) as {
      updates?: Array<{ "package-ecosystem"?: string; directory?: string }>;
    };
    const tracked = (config.updates ?? []).some(
      (entry) =>
        entry["package-ecosystem"] === "docker" && entry.directory === "/packages/cycling-coach",
    );
    expect(
      tracked,
      `dependabot.yml has no \`docker\` update entry for directory ` +
        `\`/packages/cycling-coach\`. Without it, the pinned base-image digest ` +
        `won't receive automated security bumps.`,
    ).toBe(true);
  });
});
