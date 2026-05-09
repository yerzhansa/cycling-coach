// trademark-lint:skip-file — this linter's own source legitimately names the
// forbidden tokens (FORBIDDEN_TOKENS keys, JSDoc, etc.); it must not flag
// itself. Same exemption for the linter's test (synthetic fixtures).
/**
 * Trademark substitution lint — `pnpm check:trademarks`.
 *
 * Wave 1a (F6) of the section-11 Reference initiative. Section-11 was authored
 * against TrainingPeaks vocabulary (CTL, ATL, TSB, TSS, IF, NP, "Normalized
 * Power"). Reference adopts intervals.icu's plain-English alternatives —
 * Fitness, Fatigue, Form, Load, Intensity, weighted average power. This linter
 * blocks the forbidden tokens from re-entering Reference source on PR.
 *
 * For `.ts`/`.tsx` files, we walk the TypeScript AST and check ONLY string
 * literals, template literals, and comment trivia. Code identifiers like
 * `IF` (a JS keyword in lowercase, but a legal identifier in uppercase) and
 * `NP` (a fine identifier) must not trip false positives.
 *
 * For `.md` files, we use a regex pass with word boundaries and skip fenced
 * code blocks (markdown has no AST, but code blocks are technical content
 * where forbidden tokens are typically code identifiers or test fixtures).
 *
 * The forbidden-token list lives in `FORBIDDEN_TOKENS` below. Keep it in sync
 * with `CLAUDE.local.md` and `CONTRIBUTING.md`'s "Trademark hygiene" section.
 */

import * as ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface TrademarkHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly token: string;
}

/**
 * Forbidden tokens with their substitution targets. The substitutions are
 * advisory (printed in the error report); only the keys gate the lint.
 */
export const FORBIDDEN_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  CTL: "Fitness",
  ATL: "Fatigue",
  TSB: "Form",
  TSS: "Load",
  IF: "Intensity",
  NP: "weighted average power",
  "Normalized Power": "weighted average power",
});

const TS_EXTS = new Set([".ts", ".tsx", ".cts", ".mts"]);
const MD_EXTS = new Set([".md", ".mdx"]);

function getExt(file: string): string {
  const i = file.lastIndexOf(".");
  return i === -1 ? "" : file.slice(i);
}

/**
 * Build a regex that matches each forbidden token with proper word boundaries.
 * Single-letter abbreviations (CTL, ATL, IF, NP) need `\b` to avoid matching
 * "MUST" or "consultsST". The phrase token "Normalized Power" is matched
 * case-sensitively as a unit.
 */
function buildTokenRegex(): RegExp {
  const parts = Object.keys(FORBIDDEN_TOKENS).map((token) => {
    if (/\s/.test(token)) {
      return token.replace(/\s+/g, "\\s+");
    }
    return `\\b${token}\\b`;
  });
  return new RegExp(`(${parts.join("|")})`, "g");
}

const TOKEN_RE = buildTokenRegex();

function* matchInText(
  text: string,
  baseOffset: number,
): Generator<{ offset: number; token: string }> {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    yield { offset: baseOffset + m.index, token: m[1] };
  }
}

/**
 * Files that need to legitimately mention the forbidden tokens (e.g., this
 * linter's own source, the test fixtures, project glossaries) opt out by
 * placing this directive within the first 1 KB of the file. The directive is
 * recognized in any commenting style.
 */
const SKIP_DIRECTIVE = "trademark-lint:skip-file";

function isSkippedFile(source: string): boolean {
  return source.slice(0, 1024).includes(SKIP_DIRECTIVE);
}

function findHitsInTsFile(file: string): TrademarkHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const hits: TrademarkHit[] = [];

  function recordHit(offset: number, token: string) {
    const lc = sf.getLineAndCharacterOfPosition(offset);
    hits.push({ file, line: lc.line + 1, column: lc.character + 1, token });
  }

  // Walk all string-like literals.
  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.text;
      // node.getStart() returns the position of the opening quote/backtick;
      // contents start at +1.
      const contentStart = node.getStart(sf) + 1;
      for (const hit of matchInText(text, contentStart)) {
        recordHit(hit.offset, hit.token);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Walk comment trivia (single-line, multi-line, JSDoc all surface here).
  // We scan the full source for comment ranges around each token position;
  // simpler is to scan every position's leading trivia, but the canonical
  // approach is to walk the source text looking for comments using
  // `ts.forEachLeadingCommentRange` / `getTrailingCommentRange`. For a
  // small linter, scan the whole file once: find all comment ranges via
  // the scanner.
  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    source,
  );
  let kind: ts.SyntaxKind;
  while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      const text = scanner.getTokenText();
      for (const hit of matchInText(text, start)) {
        recordHit(hit.offset, hit.token);
      }
    }
  }

  return hits;
}

function findHitsInMdFile(file: string): TrademarkHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  // Strip fenced code blocks (```...```). Replace with same-length whitespace
  // so line/column offsets stay correct for the surviving prose.
  const stripped = source.replace(
    /```[\s\S]*?```/g,
    (block) => block.replace(/[^\n]/g, " "),
  );

  const hits: TrademarkHit[] = [];
  // Compute line offsets once so we can map offset → (line, column) cheaply.
  const lineStarts: number[] = [0];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "\n") lineStarts.push(i + 1);
  }
  function offsetToLineCol(offset: number): { line: number; column: number } {
    // Binary search lineStarts.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  }

  for (const hit of matchInText(stripped, 0)) {
    const { line, column } = offsetToLineCol(hit.offset);
    hits.push({ file, line, column, token: hit.token });
  }
  return hits;
}

/**
 * Lint the given files for forbidden trademark tokens.
 *
 * Files with unsupported extensions are skipped silently; this lets the script
 * accept `git diff --name-only` output that includes `.json`, `.yaml`, etc.
 * without per-extension pre-filtering at the call site.
 */
export function findTrademarkHits(files: readonly string[]): TrademarkHit[] {
  const out: TrademarkHit[] = [];
  for (const file of files) {
    const ext = getExt(file);
    if (TS_EXTS.has(ext)) {
      out.push(...findHitsInTsFile(file));
    } else if (MD_EXTS.has(ext)) {
      out.push(...findHitsInMdFile(file));
    }
  }
  return out;
}

/** Recursively collect lintable files under a directory. */
function collectFiles(path: string, out: string[]): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    return; // missing path — caller decides whether that's an error
  }
  if (st.isFile()) {
    out.push(path);
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    collectFiles(join(path, entry), out);
  }
}

function formatHit(hit: TrademarkHit): string {
  const sub = FORBIDDEN_TOKENS[hit.token];
  return `${hit.file}:${hit.line}:${hit.column}  forbidden token "${hit.token}" — use "${sub}" instead`;
}

/**
 * Default scan scope when no paths are supplied. The Reference submodule is
 * the directly-ported code; `tools/` is in scope because this very linter
 * lives there. Add new layer directories here as future horizontal layers
 * land (e.g., `packages/core/src/decision/`).
 */
const DEFAULT_SCAN_PATHS: readonly string[] = [
  "packages/core/src/reference",
  "tools",
];

export function main(argv: readonly string[]): number {
  const args = argv.filter((a) => !a.startsWith("-"));
  const inputPaths = args.length > 0 ? args : DEFAULT_SCAN_PATHS;
  const files: string[] = [];
  for (const p of inputPaths) collectFiles(p, files);

  if (files.length === 0) {
    console.log("check-trademarks: no lintable files in scope.");
    return 0;
  }
  const hits = findTrademarkHits(files);
  if (hits.length === 0) {
    console.log(`check-trademarks: ${files.length} file(s) clean.`);
    return 0;
  }
  console.error(`check-trademarks: ${hits.length} forbidden trademark token(s) found:`);
  for (const hit of hits) {
    console.error("  " + formatHit(hit));
  }
  console.error(
    "\nSubstitute per CLAUDE.local.md / CONTRIBUTING.md " +
      "(Fitness, Fatigue, Form, Load, Intensity, weighted average power).",
  );
  return 1;
}

// CLI entrypoint when invoked directly via `tsx tools/check-trademarks.ts <files>`.
// Detect via import.meta.url instead of require.main; this file is ESM.
const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  process.exit(main(process.argv.slice(2)));
}
