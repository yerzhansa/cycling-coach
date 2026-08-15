import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?ts|mjs)$/u.test(entry.name) ? [path] : [];
  });
}

function importedSpecifiers(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function resolvesIntoTestTree(importer: string, specifier: string): boolean {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return false;
  const target = resolve(dirname(importer), specifier);
  const repositoryPath = relative(repositoryRoot, target);
  if (
    repositoryPath === "" ||
    repositoryPath.startsWith(`..${sep}`) ||
    isAbsolute(repositoryPath)
  ) {
    return false;
  }
  return repositoryPath.split(sep).includes("tests");
}

describe("Desktop acceptance support boundary", () => {
  it("keeps production Desktop scripts and configs independent of test modules", () => {
    const productionSources = [
      ...sourceFiles(resolve(desktopRoot, "scripts")),
      resolve(desktopRoot, "electron.vite.config.ts"),
      resolve(desktopRoot, "electron.telegram-acceptance.vite.config.ts"),
    ];
    const violations = productionSources.flatMap((path) =>
      importedSpecifiers(path)
        .filter((specifier) => resolvesIntoTestTree(path, specifier))
        .map((specifier) => `${relative(repositoryRoot, path)} -> ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps release workflows independent of Desktop test paths", () => {
    const workflowPaths = [
      ".github/workflows/desktop-release.yml",
      ".github/workflows/release.yml",
      ".github/workflows/version-pr.yml",
    ];
    const violations = workflowPaths.filter((path) =>
      readFileSync(resolve(repositoryRoot, path), "utf8").includes("apps/desktop/tests/"),
    );

    expect(violations).toEqual([]);
  });

  it("captures a new desktop release id from the creation response", () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, ".github/workflows/version-pr.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      'CREATED_RELEASE=$(gh api --method POST "repos/$GITHUB_REPOSITORY/releases"',
    );
    expect(workflow).toContain(
      'DRAFT_ID=$(printf \'%s\' "$CREATED_RELEASE" | jq -er \'.id | tostring\')',
    );
    expect(workflow).not.toContain(
      'DRAFT_ID=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100"',
    );
  });
});
