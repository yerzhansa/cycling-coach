import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Plugin } from "vite";
import {
  assertPreviewInputsCovered,
  previewWorkspaceDirectories,
} from "../../tools/ui-verification/preview-scope";

interface SourceHash {
  readonly path: string;
  readonly sha256: string;
}

interface ModuleImports {
  readonly id: string;
  readonly imports: readonly string[];
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function previewSourceIdentity(options: { readonly root: string }): Plugin {
  const root = resolve(options.root);
  const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const require = createRequire(resolve(root, "package.json"));
  const previewDirectories = previewWorkspaceDirectories(repository);
  const moduleSources = new Map<string, string>();
  const capturedFiles = new Map<string, string>();
  let building = false;
  let revision = "";
  let dirty = false;

  function identify(path: string): string {
    return path.replaceAll(repository, ".").replaceAll("\0", "\\0");
  }

  function gitState(): { readonly revision: string; readonly dirty: boolean } {
    const git = (args: readonly string[]): string =>
      execFileSync("git", [...args], { cwd: repository, encoding: "utf8" }).trim();
    return {
      revision: git(["rev-parse", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
    };
  }

  async function fileHash(path: string): Promise<SourceHash> {
    return { path: identify(path), sha256: hash(await readFile(path)) };
  }

  async function captureFile(path: string): Promise<SourceHash> {
    const source = await fileHash(path);
    const previous = capturedFiles.get(path);
    if (previous !== undefined && previous !== source.sha256) {
      throw new Error(`Source file changed during preview build: ${identify(path)}`);
    }
    capturedFiles.set(path, source.sha256);
    return source;
  }

  async function captureModuleFile(id: string): Promise<void> {
    if (!building || id.includes("\0")) return;
    const path = id.split("?")[0];
    if (!isAbsolute(path)) return;
    try {
      await captureFile(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EISDIR") &&
        !capturedFiles.has(path)
      )
        return;
      throw error;
    }
  }

  async function verifyFiles(): Promise<void> {
    const paths = [...capturedFiles.keys()];
    assertPreviewInputsCovered(paths.map(identify), previewDirectories);
    for (let start = 0; start < paths.length; start += 64) {
      await Promise.all(paths.slice(start, start + 64).map(captureFile));
    }
    const current = gitState();
    if (current.revision !== revision)
      throw new Error("Source revision changed during preview build");
    dirty ||= current.dirty;
  }

  async function configuration(): Promise<readonly SourceHash[]> {
    const paths = new Set([
      resolve(repository, "pnpm-lock.yaml"),
      resolve(repository, "package.json"),
      resolve(repository, "pnpm-workspace.yaml"),
      resolve(repository, "apps/desktop/package.json"),
      resolve(root, "package.json"),
      resolve(root, "vite.config.ts"),
      resolve(root, "tsconfig.json"),
      resolve(root, "tsconfig.preview.json"),
      resolve(root, "preview-identity.ts"),
      resolve(root, ".storybook/main.ts"),
      resolve(root, ".storybook/preview.tsx"),
      resolve(root, "src/theme/fonts.css"),
    ]);
    const fonts = await readFile(resolve(root, "src/theme/fonts.css"), "utf8");
    for (const imported of fonts.matchAll(/@import\s+["']([^"']+)["']/gu)) {
      const stylesheet = require.resolve(imported[1]);
      paths.add(stylesheet);
      const css = await readFile(stylesheet, "utf8");
      for (const font of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gu)) {
        if (!font[1].startsWith("data:")) paths.add(resolve(dirname(stylesheet), font[1]));
      }
    }
    return Promise.all([...paths].sort().map(building ? captureFile : fileHash));
  }

  function manifest(input: {
    readonly mode: "build" | "development";
    readonly sources: readonly SourceHash[];
    readonly fileSources: readonly SourceHash[];
    readonly graph: readonly ModuleImports[];
    readonly outputs: readonly SourceHash[];
  }) {
    const sources = [
      ...new Map(input.sources.map((source) => [source.path, source])).values(),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const fileSources = [...input.fileSources].sort((a, b) => a.path.localeCompare(b.path));
    const graph = [...input.graph].sort((a, b) => a.id.localeCompare(b.id));
    const outputs = [...input.outputs].sort((a, b) => a.path.localeCompare(b.path));
    const identity = {
      schemaVersion: 1,
      mode: input.mode,
      sourceCapture: input.mode === "build" ? "transformed-inputs" : "current-files",
      fileSourceCapture:
        input.mode === "build"
          ? "configuration-and-load-or-transform-observations"
          : "current-files",
      fileIntegrity: input.mode === "build" ? "unchanged-between-observations" : "unchecked",
      atomicFilesystemSnapshot: false,
      graphCoverage: input.mode === "build" ? "complete-build" : "requested-modules",
      revision,
      dirty,
      sourceDigest: hash(JSON.stringify(sources)),
      fileSourceDigest: hash(JSON.stringify(fileSources)),
      graphDigest: hash(JSON.stringify(graph)),
      outputDigest: hash(JSON.stringify(outputs)),
      sources,
      fileSources,
      graph,
      outputs,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
    };
    return { ...identity, digest: hash(JSON.stringify(identity)) };
  }

  return {
    name: "enduragent-preview-source-identity",
    enforce: "pre",
    configResolved(config) {
      building = config.command === "build";
    },
    async buildStart() {
      ({ revision, dirty } = gitState());
      capturedFiles.clear();
      await configuration();
      moduleSources.clear();
    },
    async load(id) {
      await captureModuleFile(id);
      return null;
    },
    async transform(code, id) {
      await captureModuleFile(id);
      moduleSources.set(id, hash(code));
      return null;
    },
    configureServer(server) {
      server.middlewares.use("/preview-source.json", async (_request, response, next) => {
        try {
          ({ revision, dirty } = gitState());
          const graph: ModuleImports[] = [];
          const sources = new Map<string, SourceHash>();
          for (const source of await configuration()) sources.set(source.path, source);
          for (const [id, module] of server.moduleGraph.idToModuleMap) {
            graph.push({
              id: identify(id),
              imports: [...module.importedModules]
                .flatMap((imported) => (imported.id === null ? [] : [identify(imported.id)]))
                .sort(),
            });
            if (module.file !== null && isAbsolute(module.file)) {
              const source = await fileHash(module.file);
              sources.set(source.path, source);
            }
          }
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(
            JSON.stringify(
              manifest({
                mode: "development",
                sources: [...sources.values()],
                fileSources: [...sources.values()],
                graph,
                outputs: [],
              }),
              null,
              2,
            ),
          );
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        await verifyFiles();
        const graph = [...this.getModuleIds()].map((id): ModuleImports => {
          const module = this.getModuleInfo(id);
          return {
            id: identify(id),
            imports:
              module === null
                ? []
                : [...module.importedIds, ...module.dynamicallyImportedIds].map(identify).sort(),
          };
        });
        const sources = [...moduleSources].map(([id, sha256]) => ({ path: identify(id), sha256 }));
        const fileSources = [...capturedFiles].map(([path, sha256]) => ({
          path: identify(path),
          sha256,
        }));
        const outputs = Object.values(bundle).map(
          (output): SourceHash => ({
            path: output.fileName,
            sha256: hash(output.type === "chunk" ? output.code : output.source),
          }),
        );
        this.emitFile({
          type: "asset",
          fileName: "preview-source.json",
          source: JSON.stringify(
            manifest({ mode: "build", sources, fileSources, graph, outputs }),
            null,
            2,
          ),
        });
      },
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (building) await verifyFiles();
      },
    },
  };
}
