import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface WorkspaceManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function workspaceProjects(): Map<string, { dir: string; manifest: WorkspaceManifest }> {
  const projects = new Map<string, { dir: string; manifest: WorkspaceManifest }>();
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(resolve(repoRoot, group))) {
      const dir = `${group}/${entry}`;
      const manifestPath = resolve(repoRoot, dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkspaceManifest;
      if (manifest.name !== undefined) projects.set(manifest.name, { dir, manifest });
    }
  }
  return projects;
}

function workspaceClosure(root: string): string[] {
  const projects = workspaceProjects();
  const seen = new Set<string>();
  const dirs: string[] = [];
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const project = projects.get(name);
    if (project === undefined) return;
    dirs.push(project.dir);
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const) {
      for (const [dependency, range] of Object.entries(project.manifest[field] ?? {})) {
        if (range.startsWith("workspace:")) walk(dependency);
      }
    }
  };
  walk(root);
  return dirs;
}

describe("Docker image supply-chain guards", () => {
  it("pins every Dockerfile base image by digest", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const fromLines = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("FROM "));

    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/);
    }
  });

  it("copies canonical legal inputs before building and preserves runtime copies", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const builderCopy = "COPY LICENSE NOTICE.md ./";
    const build = "RUN pnpm --filter cycling-coach... build";
    const runtimeCopy = "COPY --chown=root:root LICENSE NOTICE.md ./";

    expect(dockerfile.indexOf(builderCopy)).toBeGreaterThan(-1);
    expect(dockerfile.indexOf(builderCopy)).toBeLessThan(dockerfile.indexOf(build));
    expect(dockerfile.indexOf(runtimeCopy)).toBeGreaterThan(dockerfile.indexOf(build));
  });

  it("copies a manifest and a source tree for every workspace package cycling-coach needs", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const install = dockerfile.indexOf("RUN pnpm install --filter cycling-coach...");
    const build = dockerfile.indexOf("RUN pnpm --filter cycling-coach... build");
    const closure = workspaceClosure("cycling-coach");

    expect(closure).toContain("packages/engine");
    expect(closure).toContain("packages/kernel");
    expect(install).toBeGreaterThan(-1);
    for (const dir of closure) {
      const manifestCopy = dockerfile.indexOf(`COPY ${dir}/package.json ./${dir}/`);
      const sourceCopy = dockerfile.indexOf(`COPY ${dir} ./${dir}`);
      expect(manifestCopy, `${dir} manifest COPY`).toBeGreaterThan(-1);
      expect(manifestCopy).toBeLessThan(install);
      expect(sourceCopy, `${dir} source COPY`).toBeGreaterThan(install);
      expect(sourceCopy).toBeLessThan(build);
    }
  });

  it("uses lockfile-derived modern deploy with synchronized workspace injections", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const workspace = YAML.parse(
      readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8"),
    ) as {
      injectWorkspacePackages?: boolean;
      syncInjectedDepsAfterScripts?: string[];
    };

    expect(dockerfile).toContain(
      "RUN pnpm --filter cycling-coach --prod deploy /app/runtime-bundle",
    );
    expect(dockerfile).toContain(
      "cp packages/cycling-coach/package.json /app/runtime-bundle/package.json",
    );
    expect(dockerfile).not.toContain("--legacy");
    expect(dockerfile).not.toContain("delete m.pnpm.patchedDependencies");
    expect(workspace.injectWorkspacePackages).toBe(true);
    expect(workspace.syncInjectedDepsAfterScripts).toContain("build");
  });

  it("installs a checksum-verified pnpm tarball without Corepack", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      packageManager: string;
    };
    const pnpmVersion = /^pnpm@([^+]+)/u.exec(rootManifest.packageManager)?.[1];
    const pnpmSha512 = /\+sha512\.([a-f0-9]{128})$/u.exec(rootManifest.packageManager)?.[1];

    expect(pnpmVersion).toBeDefined();
    expect(pnpmSha512).toBeDefined();
    expect(dockerfile).toContain(`ARG PNPM_VERSION=${pnpmVersion}`);
    expect(dockerfile).toContain(`ARG PNPM_TARBALL_SHA512=${pnpmSha512}`);
    expect(dockerfile).toContain("https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz");
    expect(dockerfile).toContain("sha512sum -c -");
    expect(dockerfile).toContain("npm install --global --ignore-scripts /tmp/pnpm.tgz");
    expect(dockerfile.toLowerCase()).not.toContain("corepack");
  });

  it("keeps desktop-only pushes from republishing the bot image", () => {
    const workflow = YAML.parse(
      readFileSync(resolve(repoRoot, ".github/workflows/publish-image.yml"), "utf8"),
    ) as {
      on?: { push?: { "paths-ignore"?: string[] } };
      true?: { push?: { "paths-ignore"?: string[] } };
    };
    const ignored = (workflow.on ?? workflow.true)?.push?.["paths-ignore"] ?? [];

    expect(ignored).toContain("apps/desktop/**");
    expect(ignored).toContain("apps/desktop-renderer/**");
    expect(ignored).not.toContain("packages/core/**");
    expect(ignored).not.toContain("packages/engine/**");
  });

  it("keeps Dependabot watching the cycling-coach Dockerfile", () => {
    const dependabot = YAML.parse(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    ) as { updates?: Array<Record<string, unknown>> };

    expect(
      dependabot.updates?.some(
        (entry) =>
          entry["package-ecosystem"] === "docker" && entry.directory === "/packages/cycling-coach",
      ),
    ).toBe(true);
  });
});
