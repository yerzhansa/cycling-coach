import * as ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TS_EXTS, collectFiles, ext, nonFlagArgs, runGateCli } from "./lint-fs.js";

const RENDERER_DIR = "apps/desktop-renderer";

export interface RendererImportViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
  readonly replacement: string;
}

interface SpecifierRef {
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
}

function collectSpecifiers(file: string): SpecifierRef[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const specifiers: SpecifierRef[] = [];

  function record(node: ts.StringLiteralLike): void {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    specifiers.push({
      line: location.line + 1,
      column: location.character + 1,
      specifier: node.text,
    });
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      record(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      record(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function extensionlessReplacement(file: string, specifier: string): string | null {
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return null;
  const suffixIndex = specifier.search(/[?#]/u);
  const path = suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : specifier.slice(suffixIndex);
  if (!path.endsWith(".js")) return null;
  const extensionlessPath = path.slice(0, -3);
  const targetBase = resolve(dirname(file), extensionlessPath);
  if (!(existsSync(`${targetBase}.ts`) || existsSync(`${targetBase}.tsx`))) return null;
  return `${extensionlessPath}${suffix}`;
}

export function findRendererImportViolations(files: readonly string[]): RendererImportViolation[] {
  const violations: RendererImportViolation[] = [];
  for (const file of files) {
    if (!TS_EXTS.has(ext(file))) continue;
    for (const ref of collectSpecifiers(file)) {
      const replacement = extensionlessReplacement(file, ref.specifier);
      if (replacement === null) continue;
      violations.push({
        file,
        line: ref.line,
        column: ref.column,
        specifier: ref.specifier,
        replacement,
      });
    }
  }
  return violations;
}

export function main(argv: readonly string[]): number {
  const root = nonFlagArgs(argv)[0] ?? ".";
  const rendererDir = join(root, RENDERER_DIR);
  if (!existsSync(rendererDir)) {
    console.error(`check-renderer-imports: missing ${RENDERER_DIR}`);
    return 1;
  }

  const files: string[] = [];
  collectFiles(rendererDir, files);
  const sourceFiles = files.filter((file) => TS_EXTS.has(ext(file)));
  if (sourceFiles.length === 0) {
    console.error(`check-renderer-imports: no TypeScript files found under ${RENDERER_DIR}`);
    return 1;
  }

  const violations = findRendererImportViolations(sourceFiles);
  if (violations.length === 0) {
    console.log(`check-renderer-imports: ${sourceFiles.length} renderer file(s) clean.`);
    return 0;
  }

  console.error(
    `check-renderer-imports: ${violations.length} relative .js specifier(s) target TypeScript files:`,
  );
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line}:${violation.column}  replace "${violation.specifier}" with "${violation.replacement}"`,
    );
  }
  return 1;
}

runGateCli(import.meta.url, main);
