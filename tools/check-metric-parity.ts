/**
 * The gate (T04). Mechanical bit-identical assertion between our
 * Reference layer TS metric implementations and the section-11
 * Python oracle's snapshots captured by `pnpm snapshot:section-11`.
 *
 * CLI:
 *
 *   pnpm check-parity --metric=<name> --fixture=<athlete>
 *   pnpm check-parity --all                  # every metric × every fixture
 *   pnpm check-parity --metric=acwr --json   # machine-readable diff
 *
 * Exit codes:
 *   0  bit-identical match (silent) — and, if the deviation registry
 *      marks the metric `approved-cite`, the cited research file
 *      exists, contains a DOI or PMID marker, and is at least 300
 *      words. Both conditions must hold.
 *   1  parity mismatch OR cite-path enforcement failure (research
 *      file missing, no DOI/PMID, < 300 words). Structured diff goes
 *      to stdout (json mode) or stderr (default).
 *   2  the metric isn't in the registry yet. The error message tells
 *      the operator where to add it.
 *
 * Reads:
 *   - packages/core/tests/fixtures/snapshots/<athlete>/<metric>.json
 *   - packages/core/tests/fixtures/golden/<athlete>.json
 *   - tools/intentional-deviations.yaml (informational + cite enforcement)
 *
 * Does NOT:
 *   - Regenerate snapshots. That's `pnpm snapshot:section-11`. The
 *     gate is read-only.
 *   - Overwrite snapshots from current TS output. There is no
 *     `--update-snapshot` flag, by design — the snapshot is the
 *     oracle, updating it from the implementation under test
 *     defeats the discipline.
 *
 * The registry's role is intentionally split:
 *   - All entries are surfaced in the gate's output for visibility.
 *   - Only `approved-cite` entries trigger the research-file content
 *     check; `approved-revert` and `pending` entries change nothing
 *     about the bit-identical assertion (a revert means the TS now
 *     mirrors section-11, so the snapshot will match by construction).
 *   - `pending` entries that fail bit-identical surface that failure
 *     normally — the registry is not a free pass.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

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
// How to add a metric (once the TS port lands via /port-metric):
//
//   1. Implement the metric in `packages/core/src/reference/metrics/<file>.ts`
//      with the signature `(fixture: <FixtureShape>) => <ValueType>`.
//   2. Add an entry below, with `module` pointing at the TS module
//      (workspace-relative) and `exportName` matching the exported
//      function. The CLI will dynamically `import()` it.
//   3. Re-run `pnpm test`. The Vitest suite at
//      `packages/core/tests/reference-parity.test.ts` automatically
//      picks up new entries.
//
// The registry is empty until the first metric lands (T12 ports ACWR).
// An empty registry is correct, not a bug: the Vitest suite produces
// 0 test cases and `pnpm test` continues to pass.
export interface MetricRegistryEntry {
  module: string;
  exportName: string;
}

export const METRIC_REGISTRY: Record<string, MetricRegistryEntry> = {
  // Example shape for when ACWR lands via T12:
  //   acwr: {
  //     module: "../packages/core/src/reference/metrics/load-management",
  //     exportName: "computeAcwr",
  //   },
};

// ─── Deviation registry ─────────────────────────────────────────────────

export type DeviationStatus =
  | "pending"
  | "approved-revert"
  | "approved-cite"
  | "approved-bug"
  | "rejected";

export interface DeviationEntry {
  metric: string;
  section_11_implementation: string;
  our_implementation: string;
  type: string;
  status: DeviationStatus;
  justification?: {
    kind?: string;
    path?: string;
    cited_papers?: unknown[];
  };
  adr?: string;
  decided_by?: string;
  decided_at?: string;
  notes?: string;
}

export interface DeviationRegistry {
  schema_version: number;
  deviations: DeviationEntry[];
}

let _cachedRegistry: DeviationRegistry | null = null;
export function loadDeviationRegistry(): DeviationRegistry {
  if (_cachedRegistry !== null) return _cachedRegistry;
  const raw = readFileSync(DEVIATIONS_PATH, "utf8");
  const parsed = parseYaml(raw) as DeviationRegistry;
  _cachedRegistry = parsed;
  return parsed;
}

export function findDeviation(metric: string): DeviationEntry | undefined {
  return loadDeviationRegistry().deviations.find((d) => d.metric === metric);
}

// ─── Research file content validation (cite-path enforcement) ─────────
//
// `/architect` finding #2 (2026-05-21): the cite path of the porting
// discipline had zero runs against real machinery. When a deviation
// is `approved-cite`, the gate must verify the cited research file
// (a) exists at `justification.path`, (b) contains a DOI or PMID
// marker, and (c) is at least 300 words. Failing any of these is a
// gate failure — bit-identical parity alone is not enough for a
// cited deviation. This is the only place the registry's `status`
// field changes the gate's exit code; bit-identical assertion is
// unconditional.
export const RESEARCH_FILE_MIN_WORDS = 300;
export const DOI_OR_PMID_REGEX = /(10\.\d{4,9}\/[^\s\]]+|PMID:?\s*\d{3,})/i;

export interface ResearchFileValidation {
  ok: boolean;
  path?: string;
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
  if (!existsSync(abs)) {
    reasons.push(`file does not exist at ${justificationPath}`);
    return { ok: false, path: abs, reasons };
  }
  const content = readFileSync(abs, "utf8");
  if (!DOI_OR_PMID_REGEX.test(content)) {
    reasons.push("no DOI or PMID marker found (expected '10.xxxx/...' or 'PMID:...')");
  }
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount < RESEARCH_FILE_MIN_WORDS) {
    reasons.push(
      `word count ${wordCount} is below the ${RESEARCH_FILE_MIN_WORDS}-word minimum for a research summary`,
    );
  }
  return { ok: reasons.length === 0, path: abs, reasons };
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

export function snapshotPath(athlete: string, metric: string): string {
  return join(SNAPSHOTS_ROOT, athlete, `${metric}.json`);
}

export function loadSnapshot(athlete: string, metric: string): Snapshot {
  const path = snapshotPath(athlete, metric);
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

export function loadFixture(athlete: string): unknown {
  const path = join(FIXTURES_ROOT, `${athlete}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─── Discovery ─────────────────────────────────────────────────────────

export function listRegisteredMetrics(): string[] {
  return Object.keys(METRIC_REGISTRY).sort();
}

export function listFixtures(): string[] {
  if (!existsSync(SNAPSHOTS_ROOT)) return [];
  return readdirSync(SNAPSHOTS_ROOT)
    .filter((entry) => {
      try {
        return statSync(join(SNAPSHOTS_ROOT, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// ─── Parity check ──────────────────────────────────────────────────────

export interface ParityResult {
  metric: string;
  fixture: string;
  oracle: "section-11";
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
  oracle?: "section-11";
}): Promise<ParityResult> {
  const oracle = args.oracle ?? "section-11";
  const entry = METRIC_REGISTRY[args.metric];
  if (!entry) {
    throw new RegistryMissError(args.metric);
  }
  const snap = loadSnapshot(args.fixture, args.metric);
  const fixture = loadFixture(args.fixture);

  const moduleSpecifier = entry.module.startsWith(".")
    ? resolve(__dirname, entry.module)
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
    oracle,
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
  oracle?: "section-11" | "gc" | "both";
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
      case "oracle":
        if (v !== "section-11" && v !== "gc" && v !== "both") {
          throw new Error(`unknown --oracle value: ${v}`);
        }
        out.oracle = v;
        break;
      default:
        throw new Error(`unknown flag: ${tok}`);
    }
  }
  return out;
}

function formatHumanDiff(r: ParityResult): string {
  const header = `[parity] ${r.metric} / ${r.fixture}: FAIL`;
  const lines: string[] = [header];
  for (const d of r.diff.slice(0, 20)) {
    lines.push(
      `  ${d.path}: expected ${JSON.stringify(d.expected)} | got ${JSON.stringify(d.actual)}`,
    );
  }
  if (r.diff.length > 20) {
    lines.push(`  … ${r.diff.length - 20} more leaf diffs not shown`);
  }
  if (r.deviation?.status === "approved-cite" && r.deviation.cite_check && !r.deviation.cite_check.ok) {
    lines.push("  cite-path enforcement:");
    for (const reason of r.deviation.cite_check.reasons) {
      lines.push(`    - ${reason}`);
    }
  }
  if (r.deviation && r.diff.length === 0 && r.deviation.status !== "approved-cite") {
    // Shouldn't reach here under the passed=false branch, but defensive
    lines.push(`  deviation status: ${r.deviation.status} (informational)`);
  }
  return lines.join("\n");
}

function formatHumanPass(r: ParityResult): string {
  const tail = r.deviation
    ? ` (deviation: ${r.deviation.status})`
    : "";
  return `[parity] ${r.metric} / ${r.fixture}: OK${tail}`;
}

async function main(): Promise<number> {
  const args = parseCli(process.argv);
  if (args.oracle === "gc" || args.oracle === "both") {
    console.error(
      `[parity] --oracle=${args.oracle} not implemented in this build (deferred to F10)`,
    );
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
      console.log("[parity] registry is empty — nothing to check (this is normal pre-T12)");
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

// Run only when invoked as a script (not when imported by Vitest)
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
