import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPersistentOpenRouterModelMetadataCache } from "../src/openrouter-model-metadata-cache.js";

describe("persistent OpenRouter model metadata cache", () => {
  it("persists bounded non-secret snapshots with private POSIX permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-openrouter-cache-"));
    const cache = createPersistentOpenRouterModelMetadataCache(directory);
    await cache.write({
      modelId: "author/model-one",
      inputModalities: ["image", "text"],
      fetchedAtMs: 1_000,
    });
    await cache.write({
      modelId: "author/model-two",
      inputModalities: ["text"],
      fetchedAtMs: 2_000,
    });
    const reloaded = createPersistentOpenRouterModelMetadataCache(directory);
    await expect(reloaded.read("author/model-one")).resolves.toEqual({
      modelId: "author/model-one",
      inputModalities: ["image", "text"],
      fetchedAtMs: 1_000,
    });
    const path = join(directory, "openrouter-model-capabilities.json");
    const body = await readFile(path, "utf8");
    expect(body).not.toContain("apiKey");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it("fails closed to an empty cache for malformed or oversized files", async () => {
    const malformed = await mkdtemp(join(tmpdir(), "enduragent-openrouter-cache-bad-"));
    await writeFile(join(malformed, "openrouter-model-capabilities.json"), "not json", {
      mode: 0o600,
    });
    await expect(
      createPersistentOpenRouterModelMetadataCache(malformed).read("author/model"),
    ).resolves.toBeUndefined();

    const oversized = await mkdtemp(join(tmpdir(), "enduragent-openrouter-cache-large-"));
    await writeFile(join(oversized, "openrouter-model-capabilities.json"), "x".repeat(1_048_577), {
      mode: 0o600,
    });
    await chmod(oversized, 0o700);
    await expect(
      createPersistentOpenRouterModelMetadataCache(oversized).read("author/model"),
    ).resolves.toBeUndefined();
  });
});
