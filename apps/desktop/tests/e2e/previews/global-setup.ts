import type { FullConfig } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { release } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import baseline from "./baseline.json" with { type: "json" };

const manifestSchema = z.object({
  version: z.string(),
  reviewedBy: z.string().min(1),
  review: z.literal("production-regression-reference"),
  source: z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/u), fileSourceDigest: z.string() }),
  screenshots: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
});

const sourceSchema = z.object({
  mode: z.literal("build"),
  graphCoverage: z.literal("complete-build"),
  fileSources: z.array(z.object({ path: z.string(), sha256: z.string() })).min(1),
});

export default async function setup(config: FullConfig): Promise<void> {
  if (
    process.platform !== baseline.platform ||
    process.arch !== baseline.architecture ||
    release().split(".")[0] !== baseline.darwinMajor
  ) {
    throw new Error(`Screenshot baseline ${baseline.version} requires macOS 26 on arm64`);
  }
  if (!/^[a-z0-9-]+$/u.test(baseline.version)) throw new Error("Invalid baseline version");
  const repository = resolve(import.meta.dirname, "../../../../..");
  const source = sourceSchema.parse(
    JSON.parse(
      await readFile(
        resolve(repository, "apps/desktop-renderer/dist-storybook/preview-source.json"),
        "utf8",
      ),
    ),
  );
  for (const file of source.fileSources) {
    if (!file.path.startsWith("./")) continue;
    const digest = createHash("sha256")
      .update(await readFile(resolve(repository, file.path)))
      .digest("hex");
    if (digest !== file.sha256)
      throw new Error(`Storybook build is stale; rebuild before verification: ${file.path}`);
  }
  const root = resolve(import.meta.dirname, "baselines", baseline.version);
  const manifestPath = resolve(root, "manifest.json");
  const files: string[] = await readdir(root, { recursive: true }).catch(
    (error: NodeJS.ErrnoException): string[] => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  if (config.updateSnapshots !== "none" && config.updateSnapshots !== "missing") {
    if (files.includes("manifest.json"))
      throw new Error("Preserve the reviewed baseline. Choose a new version before capture.");
    return;
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.version !== baseline.version) throw new Error("Baseline version mismatch");
  const images = files.filter((file) => file.endsWith(".png")).sort();
  const expected = Object.keys(manifest.screenshots).sort();
  if (images.length === 0 || JSON.stringify(images) !== JSON.stringify(expected))
    throw new Error("Baseline screenshot inventory is missing or inconsistent");
  for (const file of images) {
    const digest = createHash("sha256")
      .update(await readFile(resolve(root, file)))
      .digest("hex");
    if (digest !== manifest.screenshots[file])
      throw new Error(`Reviewed screenshot changed without a new baseline version: ${file}`);
  }
}
