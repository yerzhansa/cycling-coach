import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertPreviewInputsCovered,
  classifyDesktopChanges,
  detectDesktopScope,
  previewWorkspaceDirectories,
} from "./preview-scope";

const repository = resolve(import.meta.dirname, "../..");
const directories = previewWorkspaceDirectories(repository);
const temporaryRepositories: string[] = [];

afterAll(() => {
  for (const path of temporaryRepositories) rmSync(path, { recursive: true, force: true });
});

function write(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "preview-ci-scope-"));
  temporaryRepositories.push(root);
  for (const { directory, name, dependencies } of [
    {
      directory: "apps/desktop-renderer",
      name: "@enduragent/desktop-renderer",
      dependencies: { "@enduragent/coach-client": "workspace:*" },
    },
    {
      directory: "packages/coach-client",
      name: "@enduragent/coach-client",
      dependencies: { "@enduragent/coach-contract": "workspace:*" },
    },
    { directory: "packages/coach-contract", name: "@enduragent/coach-contract", dependencies: {} },
    { directory: "packages/core", name: "@enduragent/core", dependencies: {} },
  ]) {
    write(root, `${directory}/package.json`, JSON.stringify({ name, dependencies }));
  }
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=CI Scope Test",
      "-c",
      "user.email=ci-scope@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function commit(root: string): string {
  git(root, "add", ".");
  git(root, "commit", "-qm", "test(ci): update fixture");
  return git(root, "rev-parse", "HEAD");
}

describe("preview CI scope", () => {
  it("includes the renderer and its transitive workspace dependencies", () => {
    expect(previewWorkspaceDirectories(fixture())).toEqual([
      "apps/desktop-renderer/",
      "packages/coach-client/",
      "packages/coach-contract/",
    ]);
  });

  it.each([
    "apps/desktop-renderer/src/theme/tokens.css",
    "apps/desktop-renderer/src/controllers/chat-controller.ts",
    "apps/desktop-renderer/preview/new.stories.tsx",
    "apps/desktop-renderer/.storybook/main.ts",
    "apps/desktop-renderer/public/new.svg",
    "packages/coach-client/src/index.ts",
    "packages/coach-contract/src/events.ts",
    "apps/desktop/package.json",
    "apps/desktop/playwright.previews.config.ts",
    "apps/desktop/tests/e2e/previews/baselines/example/manifest.json",
    "tools/ui-verification/preview-scope.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.check.json",
    ".npmrc",
    ".github/workflows/ci.yml",
    "patches/example.patch",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "unknown/build-input.json",
  ])("runs native and preview checks for %s", (path) => {
    expect(classifyDesktopChanges([path], directories)).toEqual({ native: true, previews: true });
  });

  it.each([
    "packages/core/src/agent.ts",
    "packages/coach/src/planning.ts",
    "packages/engine/tests/sync.test.ts",
    "packages/kernel/src/store.ts",
    "apps/desktop/src/main/index.ts",
    "apps/desktop/scripts/package-telegram-acceptance.mjs",
    "apps/desktop/tests/e2e/chat-core.spec.ts",
  ])("keeps native checks but skips previews for %s", (path) => {
    expect(classifyDesktopChanges([path], directories)).toEqual({ native: true, previews: false });
  });

  it.each(["README.md", ".changeset/example.md"])("skips desktop checks for %s", (path) => {
    expect(classifyDesktopChanges([path], directories)).toEqual({ native: false, previews: false });
  });

  it("runs previews for mixed backend and renderer changes", () => {
    expect(
      classifyDesktopChanges(
        ["packages/core/src/agent.ts", "apps/desktop-renderer/src/theme/tokens.css"],
        directories,
      ),
    ).toEqual({ native: true, previews: true });
  });

  it("automatically follows newly declared transitive dependencies", () => {
    const root = fixture();
    write(
      root,
      "packages/shared-ui/package.json",
      JSON.stringify({ name: "@enduragent/shared-ui" }),
    );
    write(
      root,
      "packages/coach-contract/package.json",
      JSON.stringify({
        name: "@enduragent/coach-contract",
        optionalDependencies: { "@enduragent/shared-ui": "workspace:*" },
      }),
    );
    expect(
      classifyDesktopChanges(
        ["packages/shared-ui/src/index.ts"],
        previewWorkspaceDirectories(root),
      ),
    ).toEqual({ native: true, previews: true });
  });

  it("rejects a build that imports a backend file outside the declared preview dependencies", () => {
    expect(() => assertPreviewInputsCovered(["./packages/core/src/agent.ts"], directories)).toThrow(
      "outside the CI dependency scope",
    );
    expect(() =>
      assertPreviewInputsCovered(["./packages/core/dist/index.js"], directories),
    ).toThrow("outside the CI dependency scope");
    expect(() =>
      assertPreviewInputsCovered(["./apps/desktop/out/main/index.js"], directories),
    ).toThrow("outside the CI dependency scope");
  });

  it("accepts covered source, version, configuration and installed dependency inputs", () => {
    expect(() =>
      assertPreviewInputsCovered(
        [
          "./apps/desktop-renderer/src/theme/tokens.css",
          "./packages/coach-client/dist/index.js",
          "./apps/desktop/package.json",
          "./pnpm-workspace.yaml",
          "./node_modules/.pnpm/react/node_modules/react/index.js",
        ],
        directories,
      ),
    ).not.toThrow();
  });

  it.each([undefined, "", "0".repeat(40), "f".repeat(40), "--help"])(
    "runs everything when the comparison base cannot be trusted: %s",
    (base) => {
      expect(detectDesktopScope(repository, base)).toEqual({ native: true, previews: true });
    },
  );

  it("uses both sides of a rename out of the renderer", () => {
    const root = fixture();
    git(root, "init", "-q");
    write(root, "apps/desktop-renderer/src/view.ts", "export const view = 1;\n");
    const base = commit(root);
    mkdirSync(join(root, "packages/core/src"), { recursive: true });
    git(root, "mv", "apps/desktop-renderer/src/view.ts", "packages/core/src/view.ts");
    commit(root);
    expect(detectDesktopScope(root, base)).toEqual({ native: true, previews: true });
  });

  it("detects a deleted renderer file", () => {
    const root = fixture();
    git(root, "init", "-q");
    write(root, "apps/desktop-renderer/src/view.ts", "export const view = 1;\n");
    const base = commit(root);
    rmSync(join(root, "apps/desktop-renderer/src/view.ts"));
    commit(root);
    expect(detectDesktopScope(root, base)).toEqual({ native: true, previews: true });
  });

  it("skips previews for a real backend-only Git comparison", () => {
    const root = fixture();
    git(root, "init", "-q");
    const base = commit(root);
    write(root, "packages/core/src/agent.ts", "export const agent = 1;\n");
    commit(root);
    expect(detectDesktopScope(root, base)).toEqual({ native: true, previews: false });
  });

  it("runs everything when workspace manifests cannot establish the dependency graph", () => {
    const root = fixture();
    git(root, "init", "-q");
    const base = commit(root);
    write(root, "packages/core/package.json", "invalid json");
    write(root, "packages/core/src/agent.ts", "export const agent = 1;\n");
    commit(root);
    expect(detectDesktopScope(root, base)).toEqual({ native: true, previews: true });
  });
});
