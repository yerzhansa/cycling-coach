import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkspacePackage {
  readonly directory: string;
  readonly dependencies: readonly string[];
}

export interface DesktopScope {
  readonly native: boolean;
  readonly previews: boolean;
}

const nativeDirectories = [
  "apps/desktop/",
  "apps/desktop-renderer/",
  "tools/ui-verification/",
  "packages/coach/",
  "packages/coach-cli/",
  "packages/coach-client/",
  "packages/coach-contract/",
  "packages/core/",
  "packages/engine/",
  "packages/kernel/",
  "packages/kernel-node/",
  "packages/sport-cycling/",
  "packages/sync-intervals-icu/",
];

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid workspace package manifest");
  }
  return { ...value };
}

export function previewWorkspaceDirectories(repository: string): readonly string[] {
  const packages = new Map<string, WorkspacePackage>();
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(resolve(repository, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}/`;
      const manifest = object(
        JSON.parse(readFileSync(resolve(repository, directory, "package.json"), "utf8")),
      );
      if (typeof manifest.name !== "string" || packages.has(manifest.name)) {
        throw new TypeError("Missing or duplicate workspace package name");
      }
      const dependencies: string[] = [];
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        if (manifest[field] === undefined) continue;
        for (const [name, version] of Object.entries(object(manifest[field]))) {
          if (typeof version !== "string") throw new TypeError("Invalid workspace dependency");
          if (name.startsWith("@enduragent/") || version.startsWith("workspace:")) {
            dependencies.push(name);
          }
        }
      }
      packages.set(manifest.name, { directory, dependencies });
    }
  }
  const directories = new Set<string>();
  function visit(name: string): void {
    const pkg = packages.get(name);
    if (pkg === undefined) throw new Error(`Unresolved preview workspace dependency: ${name}`);
    if (directories.has(pkg.directory)) return;
    directories.add(pkg.directory);
    pkg.dependencies.forEach(visit);
  }
  visit("@enduragent/desktop-renderer");
  return [...directories].sort();
}

export function requiresPreviews(path: string, directories: readonly string[]): boolean {
  if (directories.some((directory) => path.startsWith(directory))) return true;
  if (path.startsWith("apps/desktop/tests/e2e/previews/")) return true;
  if (/^packages\/[^/]+\/(?:src|tests)\//u.test(path)) return false;
  if (/^apps\/desktop\/(?:src|scripts|tests)\//u.test(path)) return false;
  if (/^\.changeset\/[^/]+\.md$/u.test(path)) return false;
  if (["README.md", "CONTRIBUTING.md", "CONTEXT-MAP.md", "NOTICE.md", "LICENSE"].includes(path)) {
    return false;
  }
  if (/^(?:apps|packages)\/[^/]+\/CONTEXT\.md$/u.test(path)) return false;
  return true;
}

export function assertPreviewInputsCovered(
  paths: readonly string[],
  directories: readonly string[],
): void {
  for (const path of paths) {
    if (!path.startsWith("./") || path.includes("/node_modules/")) continue;
    const relative = path.slice(2);
    const workspaceFile = relative.startsWith("apps/") || relative.startsWith("packages/");
    const coveredWorkspace = directories.some((directory) => relative.startsWith(directory));
    if (
      !requiresPreviews(relative, directories) ||
      (workspaceFile && !coveredWorkspace && relative !== "apps/desktop/package.json")
    ) {
      throw new Error(`Preview input is outside the CI dependency scope: ${relative}`);
    }
  }
}

export function classifyDesktopChanges(
  paths: readonly string[],
  directories: readonly string[],
): DesktopScope {
  const previews = paths.some((path) => requiresPreviews(path, directories));
  return {
    previews,
    native:
      previews ||
      paths.some((path) => nativeDirectories.some((directory) => path.startsWith(directory))),
  };
}

export function detectDesktopScope(repository: string, base: string | undefined): DesktopScope {
  if (base === undefined || !/^[a-f\d]{40}$/u.test(base) || /^0+$/u.test(base)) {
    return { native: true, previews: true };
  }
  try {
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"],
      {
        cwd: repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .split("\0")
      .filter(Boolean);
    return classifyDesktopChanges(paths, previewWorkspaceDirectories(repository));
  } catch {
    return { native: true, previews: true };
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(import.meta.dirname, "../..");
  const scope = detectDesktopScope(repository, process.env.BASE_SHA);
  const output = `native=${scope.native}\npreviews=${scope.previews}\n`;
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
