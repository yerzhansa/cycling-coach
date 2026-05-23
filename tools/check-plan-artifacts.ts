// plan-artifact-lint:skip-file — this linter's source literally encodes the
// forbidden patterns (regex set, JSDoc, examples). It must not flag itself or
// its test fixtures.
/**
 * Internal-plan-artifact vocabulary lint — `pnpm check:plan-artifacts`.
 *
 * The plan-artifact vocabulary (wave numbers, feature IDs, decision IDs,
 * phase letters, PR letters, "battle plan", "Reference PRD", "section-11",
 * "issue #N") points at documents that live under the gitignored `docs/`
 * tree. Those references rot the moment a PR squashes — a future reader of
 * a code comment or shipped doc cannot open them. The repository ships
 * `CONTEXT.md`, `SOUL.md`, `README.md` and source files; the lint guards
 * those surfaces against the vocabulary leak.
 *
 * Scope (per the lint ticket's AC2):
 *   - packages/&#42;&#42;/src/&#42;&#42;/&#42;.{ts,md}
 *   - packages/&#42;&#42;/{CONTEXT,SOUL,README}.md
 *   - packages/&#42;&#42;/tests/&#42;&#42;/README.md
 *   - CONTEXT-MAP.md
 *   - CONTRIBUTING.md
 *
 * Allowlist (per AC3): NOTICE.md, root README.md, .changeset/&#42;.md,
 * CHANGELOG.md (root + any package). Per-file opt-out via the
 * `plan-artifact-lint:skip-file` directive in the first 1 KB.
 *
 * Output: file:line:column report per match; exit 1 if any match, else 0.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PlanArtifactHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly token: string;
  readonly label: string;
}

interface Pattern {
  readonly re: RegExp;
  readonly label: string;
}

/**
 * The forbidden patterns. Each regex carries the global flag so the scanner
 * can iterate matches with `exec`. Order is reporting-only; matches from all
 * patterns are aggregated and sorted by position.
 */
export const PATTERNS: readonly Pattern[] = Object.freeze([
  { re: /\bWave[ -]?\d+\b/g, label: "Wave-N" },
  { re: /\bF\d+(?:[–-]F?\d+)?\b/g, label: "F-ID" },
  { re: /\bDecision \d+\b/g, label: "Decision-N" },
  { re: /\bPhase [A-Z\d]+\b/g, label: "Phase-X" },
  { re: /\bPR [A-F]\b/g, label: "PR-X" },
  { re: /\bbattle[- ]plan\b/g, label: "battle-plan" },
  { re: /\bReference PRD\b/g, label: "Reference-PRD" },
  { re: /\barchitect-final\b/g, label: "architect-final" },
  { re: /\bsection-11\b/g, label: "section-11" },
  { re: /\bsection 11\b/g, label: "section-11" },
  { re: /\bissue #\d+\b/g, label: "issue-#N" },
]);

const SKIP_DIRECTIVE = "plan-artifact-lint:skip-file";

function isSkippedFile(source: string): boolean {
  return source.slice(0, 1024).includes(SKIP_DIRECTIVE);
}

/**
 * Strip markdown fenced code blocks by replacing them with whitespace of the
 * same shape, so line/column offsets stay intact. Fenced code typically
 * contains technical content (identifiers, fixtures); we only lint prose.
 */
function stripFencedCodeBlocks(source: string): string {
  return source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

/**
 * Lint a single file. The scanner is the same for `.ts` and `.md`: it walks
 * the (optionally fenced-code-stripped) text against every pattern. We do
 * NOT walk a TS AST here — the plan-artifact tokens (`Wave 2`, `Phase D`,
 * `battle-plan`, `issue #47`) are prose constructs that don't clash with
 * legal JS/TS identifiers in this codebase.
 */
function findHitsInFile(file: string): PlanArtifactHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const isMd = file.endsWith(".md") || file.endsWith(".mdx");
  const text = isMd ? stripFencedCodeBlocks(source) : source;
  const lineStarts = buildLineStarts(text);

  const hits: PlanArtifactHit[] = [];
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const { line, column } = offsetToLineCol(lineStarts, m.index);
      hits.push({ file, line, column, token: m[0], label });
    }
  }
  hits.sort(
    (a, b) => a.line - b.line || a.column - b.column || a.label.localeCompare(b.label),
  );
  return hits;
}

export function findPlanArtifactHits(files: readonly string[]): PlanArtifactHit[] {
  const out: PlanArtifactHit[] = [];
  for (const file of files) {
    if (!isLintableExt(file)) continue;
    out.push(...findHitsInFile(file));
  }
  return out;
}

function isLintableExt(file: string): boolean {
  return file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".md") || file.endsWith(".mdx");
}

/**
 * Allowlist by repo-relative path. Entries are exact paths or path prefixes
 * (a trailing `/` marks a directory prefix). Root README.md is allowlisted
 * in full per AC3 — its Credits section legitimately names section-11; the
 * rest of the file is brief enough that adding a finer-grained gate would
 * cost more maintenance than it earns.
 */
const ALLOWLIST_EXACT: ReadonlySet<string> = new Set([
  "NOTICE.md",
  "README.md",
  "CHANGELOG.md",
]);

const ALLOWLIST_PREFIX: readonly string[] = [
  ".changeset/",
];

/**
 * Allowlist by path suffix — covers per-package CHANGELOG.md files
 * (`packages/<name>/CHANGELOG.md`) without enumerating every package.
 */
const ALLOWLIST_SUFFIX: readonly string[] = [
  "/CHANGELOG.md",
];

function isAllowlisted(repoRel: string): boolean {
  const norm = repoRel.split(sep).join("/");
  if (ALLOWLIST_EXACT.has(norm)) return true;
  for (const p of ALLOWLIST_PREFIX) if (norm.startsWith(p)) return true;
  for (const s of ALLOWLIST_SUFFIX) if (norm.endsWith(s)) return true;
  return false;
}

/**
 * Collect every git-tracked file that matches the lint's scope under the
 * given repo root.
 */
export function collectScopedFiles(repoRoot: string): string[] {
  const out: string[] = [];

  const ctxMap = join(repoRoot, "CONTEXT-MAP.md");
  if (existsSync(ctxMap)) out.push(ctxMap);
  const contributing = join(repoRoot, "CONTRIBUTING.md");
  if (existsSync(contributing)) out.push(contributing);

  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return out;

  for (const pkg of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, pkg);
    let st;
    try {
      st = statSync(pkgDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    for (const top of ["CONTEXT.md", "SOUL.md", "README.md"]) {
      const p = join(pkgDir, top);
      if (existsSync(p)) out.push(p);
    }

    const srcDir = join(pkgDir, "src");
    if (existsSync(srcDir)) walkSrc(srcDir, out);

    const testsDir = join(pkgDir, "tests");
    if (existsSync(testsDir)) walkTestsForReadmes(testsDir, out);
  }

  return out;
}

function walkSrc(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    // Co-located tests routinely reference plan-artifact tokens in describe
    // strings for traceability. The lint targets shipped surfaces (CONTEXT,
    // SOUL, README, src code); tests are out of scope per the ticket's AC2.
    if (entry === "__tests__") continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx") ||
        entry.endsWith(".spec.ts") || entry.endsWith(".spec.tsx")) continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSrc(p, out);
    } else if (st.isFile() && isLintableExt(p)) {
      out.push(p);
    }
  }
}

function walkTestsForReadmes(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTestsForReadmes(p, out);
    } else if (st.isFile() && entry === "README.md") {
      out.push(p);
    }
  }
}

function formatHit(repoRoot: string, hit: PlanArtifactHit): string {
  const rel = relative(repoRoot, hit.file) || hit.file;
  return `${rel}:${hit.line}:${hit.column}  [${hit.label}] forbidden token "${hit.token}"`;
}

export function main(argv: readonly string[], repoRoot: string = process.cwd()): number {
  const args = argv.filter((a) => !a.startsWith("-"));
  let files: string[];
  if (args.length > 0) {
    files = args.map((a) => (a.startsWith("/") ? a : join(repoRoot, a)));
  } else {
    files = collectScopedFiles(repoRoot);
  }

  const lintable = files.filter((f) => {
    const rel = relative(repoRoot, f) || f;
    if (isAllowlisted(rel)) return false;
    return isLintableExt(f);
  });

  if (lintable.length === 0) {
    console.log("check-plan-artifacts: no lintable files in scope.");
    return 0;
  }

  const hits = findPlanArtifactHits(lintable);
  if (hits.length === 0) {
    console.log(`check-plan-artifacts: ${lintable.length} file(s) clean.`);
    return 0;
  }

  console.error(
    `check-plan-artifacts: ${hits.length} forbidden token(s) across ${
      new Set(hits.map((h) => h.file)).size
    } file(s):`,
  );
  for (const hit of hits) {
    console.error("  " + formatHit(repoRoot, hit));
  }
  console.error(
    "\nInternal-plan-artifact vocabulary (wave numbers, F-IDs, decision IDs,\n" +
      "phase letters, PR letters, 'battle plan', 'Reference PRD', 'section-11',\n" +
      "'issue #N') points at gitignored docs that rot on squash. Rewrite the\n" +
      "prose around what the code/doc itself describes, or add the directive\n" +
      `'${SKIP_DIRECTIVE}' within the first 1 KB if the file legitimately\n` +
      "needs the vocabulary (NOTICE.md, root README, CHANGELOGs are\n" +
      "allowlisted automatically).",
  );
  return 1;
}

// Compare paths via fileURLToPath so directories with spaces or non-ASCII
// don't break the CLI dispatch — `import.meta.url` is percent-encoded while
// `process.argv[1]` is the raw path.
const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isCli) {
  process.exit(main(process.argv.slice(2)));
}
