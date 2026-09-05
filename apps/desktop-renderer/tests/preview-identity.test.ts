import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build, createServer, type Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { previewSourceIdentity } from "../preview-identity";

const rendererRoot = resolve(import.meta.dirname, "..");
const fixtureId = "\0preview-identity-fixture";

function fixture(source: string): Plugin {
  return {
    name: "preview-identity-fixture",
    resolveId(id) {
      return id === "preview-identity-fixture" ? fixtureId : null;
    },
    load(id) {
      return id === fixtureId ? source : null;
    },
  };
}

async function buildIdentity(input: {
  readonly entry: string;
  readonly plugins: readonly Plugin[];
}): Promise<string> {
  const result = await build({
    root: rendererRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [...input.plugins, previewSourceIdentity({ root: rendererRoot })],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: input.entry },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const asset of output.output) {
      if (asset.type === "asset" && asset.fileName === "preview-source.json") {
        return typeof asset.source === "string"
          ? asset.source
          : new TextDecoder().decode(asset.source);
      }
    }
  }
  throw new Error("Preview source identity was not emitted");
}

describe("preview source identity", () => {
  it("captures build inputs, font bytes, lockfile and outputs and changes with a dirty fixture", async () => {
    const source = "globalThis.previewFixture = 'fictional-a';";
    const first = await buildIdentity({
      entry: "preview-identity-fixture",
      plugins: [fixture(source)],
    });
    const second = await buildIdentity({
      entry: "preview-identity-fixture",
      plugins: [fixture("globalThis.previewFixture = 'fictional-b';")],
    });
    const metadata: unknown = JSON.parse(first);
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      mode: "build",
      sourceCapture: "transformed-inputs",
      fileSourceCapture: "configuration-and-load-or-transform-observations",
      fileIntegrity: "unchanged-between-observations",
      atomicFilesystemSnapshot: false,
      graphCoverage: "complete-build",
      revision: expect.stringMatching(/^[a-f0-9]{40}$/u),
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      fileSourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      graphDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sources: expect.arrayContaining([
        expect.objectContaining({
          path: "\\0preview-identity-fixture",
          sha256: createHash("sha256").update(source).digest("hex"),
        }),
      ]),
      fileSources: expect.arrayContaining([
        expect.objectContaining({ path: "./pnpm-lock.yaml" }),
        expect.objectContaining({ path: expect.stringMatching(/\.woff2$/u) }),
      ]),
      outputs: expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/\.js$/u) }),
      ]),
    });
    expect(JSON.parse(second)).not.toEqual(metadata);
  }, 30_000);

  it("keeps raw file hashes separate from transformed input and exposes later source changes", async () => {
    const directory = await realpath(await mkdtemp(resolve(tmpdir(), "preview-identity-")));
    const entry = resolve(directory, "fixture.js");
    const raw = "globalThis.previewFixture = 'raw-file';";
    const transformed = "globalThis.previewFixture = 'transformed-input';";
    const rewrite: Plugin = {
      name: "transform-preview-file-fixture",
      enforce: "pre",
      transform(_code, id) {
        return id === entry ? transformed : null;
      },
    };
    try {
      await writeFile(entry, raw);
      const first: unknown = JSON.parse(await buildIdentity({ entry, plugins: [rewrite] }));
      expect(first).toMatchObject({
        sources: expect.arrayContaining([
          {
            path: entry,
            sha256: createHash("sha256").update(transformed).digest("hex"),
          },
        ]),
        fileSources: expect.arrayContaining([
          {
            path: entry,
            sha256: createHash("sha256").update(raw).digest("hex"),
          },
        ]),
      });
      const edited = "globalThis.previewFixture = 'edited-file';";
      await writeFile(entry, edited);
      const second: unknown = JSON.parse(await buildIdentity({ entry, plugins: [rewrite] }));
      expect(second).toMatchObject({
        sources: expect.arrayContaining([
          {
            path: entry,
            sha256: createHash("sha256").update(transformed).digest("hex"),
          },
        ]),
        fileSources: expect.arrayContaining([
          {
            path: entry,
            sha256: createHash("sha256").update(edited).digest("hex"),
          },
        ]),
      });
      expect(second).not.toEqual(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a consumed file changed during the build", async () => {
    const directory = await realpath(await mkdtemp(resolve(tmpdir(), "preview-identity-")));
    const entry = resolve(directory, "fixture.js");
    const mutate: Plugin = {
      name: "mutate-preview-file-during-build",
      async generateBundle() {
        await writeFile(entry, "globalThis.previewFixture = 'changed-after-transform';");
      },
    };
    try {
      await writeFile(entry, "globalThis.previewFixture = 'captured';");
      await expect(buildIdentity({ entry, plugins: [mutate] })).rejects.toThrow(
        "Source file changed during preview build:",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("serves development identity without presenting the requested module graph as a complete build", async () => {
    const server = await createServer({
      root: rendererRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [previewSourceIdentity({ root: rendererRoot })],
      server: { middlewareMode: true, hmr: false },
    });
    const http = createHttpServer(server.middlewares);
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", resolve);
      });
      const address = http.address();
      if (address === null || address === undefined || typeof address === "string") {
        throw new Error("Preview identity server has no TCP address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/preview-source.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        mode: "development",
        sourceCapture: "current-files",
        graphCoverage: "requested-modules",
        outputs: [],
      });
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await server.close();
    }
  }, 30_000);
});
