/**
 * Bit-identical parity gate between the Reference layer's TypeScript
 * metric implementations and the per-metric snapshots produced by
 * `pnpm snapshot:section-11`.
 *
 * Why no `--update-snapshot` flag: the snapshot IS the oracle; rewriting
 * it from the implementation under test defeats the discipline. Snapshots
 * regenerate only by re-running the harness against the upstream source.
 *
 * Why a research-file content check sits inside the gate: bit-identical
 * parity is necessary but not sufficient for a deviation that ships
 * `approved-cite` — the discipline requires that the cited research
 * file exists, contains a DOI or PMID marker, and is at least 300
 * words. The gate enforces it mechanically so the cite path can't
 * silently weaken.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, "..");
const SNAPSHOTS_ROOT = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/snapshots",
);
const FIXTURES_ROOT = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/golden",
);
const DEVIATIONS_PATH = resolve(REPO_ROOT, "tools/intentional-deviations.yaml");

// ─── Metric registry ────────────────────────────────────────────────────
//
// How to add a metric:
//
//   1. Implement the metric in `packages/core/src/reference/metrics/<file>.ts`
//      with the signature `(fixture: <FixtureShape>) => <ValueType>`.
//   2. Add an entry below, with `module` pointing at the TS module
//      (this-file-relative) and `exportName` matching the exported
//      function. The CLI will dynamically `import()` it.
//   3. Re-run `pnpm test`. The Vitest matrix at
//      `packages/core/tests/reference-parity.test.ts` automatically
//      picks up new entries.
//
// An empty registry is correct: the Vitest matrix produces zero cases
// and `pnpm test` continues to pass.
export interface MetricRegistryEntry {
  module: string;
  exportName: string;
}

export const METRIC_REGISTRY: Record<string, MetricRegistryEntry> = {};

// ─── Deviation registry ─────────────────────────────────────────────────
//
// Schema-validated at load time so a Phase-4 reviewer typo (status:
// "approved-revrt", missing required field, extra key) fails loud with the
// path that's wrong instead of silently weakening the cite-path check.

export const DeviationStatusSchema = z.enum([
  "pending",
  "approved-revert",
  "approved-cite",
  "approved-bug",
  "rejected",
]);
export type DeviationStatus = z.infer<typeof DeviationStatusSchema>;

export const DeviationJustificationSchema = z
  .object({
    kind: z.string().optional(),
    path: z.string().optional(),
    cited_papers: z.array(z.unknown()).optional(),
  })
  .strict();

export const DeviationEntrySchema = z
  .object({
    metric: z.string(),
    section_11_implementation: z.string(),
    our_implementation: z.string(),
    type: z.string(),
    status: DeviationStatusSchema,
    justification: DeviationJustificationSchema.optional(),
    adr: z.string().optional(),
    decided_by: z.string().optional(),
    decided_at: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();
export type DeviationEntry = z.infer<typeof DeviationEntrySchema>;

export const DeviationRegistrySchema = z
  .object({
    schema_version: z.literal(1),
    deviations: z.array(DeviationEntrySchema),
  })
  .strict();
export type DeviationRegistry = z.infer<typeof DeviationRegistrySchema>;

let registryCache: DeviationRegistry | undefined;
let deviationByMetricCache: Map<string, DeviationEntry> | undefined;

export function loadDeviationRegistry(): DeviationRegistry {
  if (registryCache === undefined) {
    const raw = readFileSync(DEVIATIONS_PATH, "utf8");
    const parsed = parseYaml(raw);
    const result = DeviationRegistrySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `tools/intentional-deviations.yaml failed schema validation:\n${result.error.message}`,
      );
    }
    registryCache = result.data;
  }
  return registryCache;
}

export function findDeviation(metric: string): DeviationEntry | undefined {
  if (deviationByMetricCache === undefined) {
    deviationByMetricCache = new Map(
      loadDeviationRegistry().deviations.map((d) => [d.metric, d]),
    );
  }
  return deviationByMetricCache.get(metric);
}

// Test-only hook: tests that drive synthetic registries through edge cases
// need to invalidate the module-level memo between assertions. Production
// callers should never touch this.
export function __resetRegistryCacheForTesting(): void {
  registryCache = undefined;
  deviationByMetricCache = undefined;
}

// ─── Research file content validation (cite-path enforcement) ─────────
//
// When a deviation ships `approved-cite`, bit-identical parity against
// the snapshot is not sufficient — the gate also verifies (a) the
// `justification.path` file exists, (b) it contains a DOI or PMID
// marker, and (c) it is at least 300 words. Failing any of those is
// a gate failure: a thin or absent citation makes the deviation hollow.
export const RESEARCH_FILE_MIN_WORDS = 300;
export const DOI_OR_PMID_REGEX = /(10\.\d{4,9}\/[^\s\]]+|PMID:?\s*\d{3,})/i;

export interface ResearchFileValidation {
  ok: boolean;
  reasons: string[];
}

export function validateResearchFile(
  justificationPath: string | undefined,
): ResearchFileValidation {
  const reasons: string[] = [];
  if (!justificationPath) {
    reasons.push("justification.path is empty");
    return { ok: false, reasons };
  }
  const abs = resolve(REPO_ROOT, justificationPath);
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      reasons.push(`file does not exist at ${justificationPath}`);
      return { ok: false, reasons };
    }
    throw err;
  }
  if (!DOI_OR_PMID_REGEX.test(content)) {
    reasons.push("no DOI or PMID marker found (expected '10.xxxx/...' or 'PMID:...')");
  }
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < RESEARCH_FILE_MIN_WORDS) {
    reasons.push(
      `word count ${wordCount} is below the ${RESEARCH_FILE_MIN_WORDS}-word minimum for a research summary`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

// ─── Comparison ─────────────────────────────────────────────────────────

export interface DiffLeaf {
  path: string;
  expected: unknown;
  actual: unknown;
}

export function deepCompare(
  expected: unknown,
  actual: unknown,
  path = "$",
): DiffLeaf[] {
  if (Object.is(expected, actual)) return [];
  if (
    typeof expected !== typeof actual ||
    expected === null ||
    actual === null ||
    typeof expected !== "object"
  ) {
    return [{ path, expected, actual }];
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [{ path, expected, actual }];
    }
    if (expected.length !== actual.length) {
      return [{ path: `${path}.length`, expected: expected.length, actual: actual.length }];
    }
    const out: DiffLeaf[] = [];
    for (let i = 0; i < expected.length; i++) {
      out.push(...deepCompare(expected[i], actual[i], `${path}[${i}]`));
    }
    return out;
  }
  const eo = expected as Record<string, unknown>;
  const ao = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(eo), ...Object.keys(ao)]);
  const out: DiffLeaf[] = [];
  for (const k of keys) {
    out.push(...deepCompare(eo[k], ao[k], `${path}.${k}`));
  }
  return out;
}

// ─── Snapshot + fixture loaders ────────────────────────────────────────

export interface Snapshot {
  metric: string;
  athlete: string;
  section_11_sha: string;
  section_11_protocol_version: string;
  frozen_now: string;
  value: unknown;
}

export interface Manifest {
  section_11_sha: string;
  section_11_protocol_version: string;
  section_11_commit_date: string;
  fixtures: string[];
  metrics: string[];
  pyodide_version: string;
  frozen_now: string;
  offline_mode: "A_stub_requests_plus_monkey_patch";
}

export function snapshotPath(athlete: string, metric: string): string {
  return join(SNAPSHOTS_ROOT, athlete, `${metric}.json`);
}

export function loadSnapshot(athlete: string, metric: string): Snapshot {
  const path = snapshotPath(athlete, metric);
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

// Returns the parsed JSON as `unknown`. The gate intentionally does not
// Zod-validate fixtures here — that's a metric-function entry concern.
// (`packages/core/tests/helpers/load-fixture.ts` is the validating loader
// for in-package tests.)
export function loadGoldenFixture(athlete: string): unknown {
  const path = join(FIXTURES_ROOT, `${athlete}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─── Discovery ─────────────────────────────────────────────────────────

export function listRegisteredMetrics(): string[] {
  return Object.keys(METRIC_REGISTRY).sort();
}

export function listFixtures(): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(SNAPSHOTS_ROOT, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ─── Parity check ──────────────────────────────────────────────────────

export interface ParityResult {
  metric: string;
  fixture: string;
  passed: boolean;
  diff: DiffLeaf[];
  deviation?: {
    status: DeviationStatus;
    decided_by?: string;
    decided_at?: string;
    cite_check?: ResearchFileValidation;
  };
}

export async function runParityCheck(args: {
  metric: string;
  fixture: string;
}): Promise<ParityResult> {
  const entry = METRIC_REGISTRY[args.metric];
  if (!entry) {
    throw new RegistryMissError(args.metric);
  }
  const snap = loadSnapshot(args.fixture, args.metric);
  const fixture = loadGoldenFixture(args.fixture);

  const moduleSpecifier = entry.module.startsWith(".")
    ? pathToFileURL(resolve(__dirname, entry.module)).href
    : entry.module;
  const mod = (await import(moduleSpecifier)) as Record<string, unknown>;
  const computeFn = mod[entry.exportName] as
    | ((input: unknown) => unknown)
    | undefined;
  if (typeof computeFn !== "function") {
    throw new Error(
      `metric '${args.metric}' registry entry resolves to ${entry.module}#${entry.exportName} ` +
        "but that export is not a function",
    );
  }
  const actual = computeFn(fixture);
  const diff = deepCompare(snap.value, actual);

  const deviation = findDeviation(args.metric);
  let citeCheck: ResearchFileValidation | undefined;
  if (deviation?.status === "approved-cite") {
    citeCheck = validateResearchFile(deviation.justification?.path);
  }

  const passed = diff.length === 0 && (citeCheck?.ok ?? true);

  return {
    metric: args.metric,
    fixture: args.fixture,
    passed,
    diff,
    deviation: deviation
      ? {
          status: deviation.status,
          decided_by: deviation.decided_by,
          decided_at: deviation.decided_at,
          cite_check: citeCheck,
        }
      : undefined,
  };
}

export class RegistryMissError extends Error {
  constructor(metric: string) {
    super(
      `metric '${metric}' not in registry; add an entry to METRIC_REGISTRY in tools/check-metric-parity.ts`,
    );
    this.name = "RegistryMissError";
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────

interface CliArgs {
  metric?: string;
  fixture?: string;
  all?: boolean;
  json?: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (const tok of argv.slice(2)) {
    const [k, v] = tok.startsWith("--") ? tok.slice(2).split("=") : [tok, "true"];
    switch (k) {
      case "metric":
        out.metric = v;
        break;
      case "fixture":
        out.fixture = v;
        break;
      case "all":
        out.all = true;
        break;
      case "json":
        out.json = true;
        break;
      default:
        throw new Error(`unknown flag: ${tok}`);
    }
  }
  return out;
}

const DIFF_LEAF_LIMIT = 20;

function summarize(value: unknown, maxLen = 120): string {
  const s = JSON.stringify(value);
  return s !== undefined && s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : String(s);
}

function formatHumanDiff(r: ParityResult): string {
  const header = `[parity] ${r.metric} / ${r.fixture}: FAIL`;
  const lines: string[] = [header];
  for (const d of r.diff.slice(0, DIFF_LEAF_LIMIT)) {
    lines.push(`  ${d.path}: expected ${summarize(d.expected)} | got ${summarize(d.actual)}`);
  }
  if (r.diff.length > DIFF_LEAF_LIMIT) {
    lines.push(`  … ${r.diff.length - DIFF_LEAF_LIMIT} more leaf diffs not shown`);
  }
  if (r.deviation?.status === "approved-cite" && r.deviation.cite_check && !r.deviation.cite_check.ok) {
    lines.push("  cite-path enforcement:");
    for (const reason of r.deviation.cite_check.reasons) {
      lines.push(`    - ${reason}`);
    }
  }
  return lines.join("\n");
}

function formatHumanPass(r: ParityResult): string {
  const tail = r.deviation ? ` (deviation: ${r.deviation.status})` : "";
  return `[parity] ${r.metric} / ${r.fixture}: OK${tail}`;
}

async function main(): Promise<number> {
  const args = parseCli(process.argv);

  if (args.all && args.metric) {
    console.error("[parity] --all and --metric are mutually exclusive");
    return 2;
  }

  const pairs: { metric: string; fixture: string }[] = [];
  if (args.all) {
    const metrics = listRegisteredMetrics();
    const fixtures = listFixtures();
    for (const m of metrics) for (const f of fixtures) pairs.push({ metric: m, fixture: f });
  } else {
    if (!args.metric) {
      console.error("[parity] --metric is required (or --all)");
      return 2;
    }
    const fixtures = args.fixture && args.fixture !== "all" ? [args.fixture] : listFixtures();
    for (const f of fixtures) pairs.push({ metric: args.metric, fixture: f });
  }

  if (pairs.length === 0) {
    if (args.all) {
      console.log("[parity] registry is empty — nothing to check");
      return 0;
    }
    console.error("[parity] no fixtures found");
    return 2;
  }

  const results: ParityResult[] = [];
  let failed = 0;
  let registryMissed = 0;
  for (const pair of pairs) {
    try {
      const r = await runParityCheck(pair);
      results.push(r);
      if (!r.passed) failed += 1;
    } catch (err) {
      if (err instanceof RegistryMissError) {
        registryMissed += 1;
        if (!args.json) console.error(`[parity] ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      if (r.passed) console.log(formatHumanPass(r));
      else console.error(formatHumanDiff(r));
    }
  }

  if (registryMissed > 0) return 2;
  if (failed > 0) return 1;
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  void main().then((code) => process.exit(code));
}
