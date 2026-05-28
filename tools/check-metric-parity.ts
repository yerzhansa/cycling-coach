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

import type { MetricInput } from "../packages/core/src/reference/metrics/metric-input.js";
import {
  METRIC_REGISTRY,
  type MetricRegistryEntry,
} from "../packages/core/src/reference/metrics/registry.js";
import {
  FixtureSchema,
  type FixtureShape,
} from "../packages/core/src/reference/schemas/inputs.js";

export type { MetricInput, MetricRegistryEntry };
export { METRIC_REGISTRY };

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

// Validates the fixture against `FixtureSchema` at the gate boundary
// (ADR-0017). Failures throw with the fixture path and the Zod issue
// tree so a malformed fixture surfaces here, not deep inside a metric.
// Top-level keys are strict — a rogue field (typo, undeclared addition)
// fails the parse; per-row schemas stay loose so real upstream shape
// rides through.
export function loadGoldenFixture(athlete: string): FixtureShape {
  const path = join(FIXTURES_ROOT, `${athlete}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const result = FixtureSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `fixture ${athlete}.json failed schema parse:\n${result.error.message}`,
    );
  }
  return result.data;
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

// Returns the set of metric names that have at least one snapshot file
// on disk across any fixture directory. Used by `--all` to surface
// metrics that have an oracle snapshot but no TS implementation in the
// registry — without it, those snapshots silently sit unverified and
// `--all` reports an all-green signal that is weaker than it appears.
export function listMetricsWithSnapshotsOnDisk(): string[] {
  const fixtures = listFixtures();
  const metrics = new Set<string>();
  for (const fixture of fixtures) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(SNAPSHOTS_ROOT, fixture), {
        withFileTypes: true,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        metrics.add(entry.name.slice(0, -".json".length));
      }
    }
  }
  return [...metrics].sort();
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
  // Object.hasOwn guards against prototype-chain lookups: `--metric=toString`
  // would otherwise resolve to `Object.prototype.toString` (a Function) and
  // crash with an opaque `entry.compute is not a function` instead of a
  // clean RegistryMissError.
  const entry = Object.hasOwn(METRIC_REGISTRY, args.metric)
    ? METRIC_REGISTRY[args.metric]
    : undefined;
  if (!entry) {
    throw new RegistryMissError(args.metric);
  }
  const snap = loadSnapshot(args.fixture, args.metric);
  const fixture = loadGoldenFixture(args.fixture);

  const actual = entry.compute({ fixture, frozenNow: snap.frozen_now });
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
  strict?: boolean;
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
      case "strict":
        out.strict = true;
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
  if (args.strict && !args.all) {
    console.error("[parity] --strict requires --all");
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

  // Audit-only check: when running --all, surface metrics that have a
  // snapshot on disk but no entry in METRIC_REGISTRY. Without this, --all
  // reports an all-green signal that silently excludes ~40 unimplemented
  // metrics. --strict promotes the warning to an exit-2 error.
  let unregisteredOnDisk: string[] = [];
  if (args.all) {
    const registered = new Set(listRegisteredMetrics());
    unregisteredOnDisk = listMetricsWithSnapshotsOnDisk().filter(
      (m) => !registered.has(m),
    );
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ results, unregistered_on_disk: unregisteredOnDisk }, null, 2)}\n`,
    );
  } else {
    for (const r of results) {
      if (r.passed) console.log(formatHumanPass(r));
      else console.error(formatHumanDiff(r));
    }
    if (unregisteredOnDisk.length > 0) {
      const level = args.strict ? "ERROR" : "WARN";
      console.error(
        `[parity] ${level}: ${unregisteredOnDisk.length} metric(s) have snapshots on disk but no METRIC_REGISTRY entry:`,
      );
      for (const m of unregisteredOnDisk) console.error(`  - ${m}`);
      if (!args.strict) {
        console.error(
          "[parity]   (these snapshots were NOT verified; pass --strict to fail on this)",
        );
      }
    }
  }

  if (registryMissed > 0) return 2;
  if (args.strict && unregisteredOnDisk.length > 0) return 2;
  if (failed > 0) return 1;
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  void main().then((code) => process.exit(code));
}
