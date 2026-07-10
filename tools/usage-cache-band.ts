/**
 * usage:cache-band — cache-economics acceptance-band analyzer over the usage ledger.
 *
 * Reads the usage ledger (and its rotated `.1` sibling, oldest first) and prints a
 * machine-checkable verdict against two bounds:
 *   1. Cache-hit ratio: sum(cacheReadTokens) / sum(inputTokens) over chat-role
 *      generate lines on breakpoint-capable routes must be >= 60%.
 *   2. Daily cost: projected steady-state spend over the whole window must be
 *      <= $0.25/day, with per-line cost RECOMPUTED FROM TOKENS.
 *
 * Per-line cost is recomputed from tokens (never read from the ledger's `cost`
 * field, which double-bills cached tokens and overstates spend): the recompute
 * charges only the uncached input at the full input rate and prices cache-read
 * and cache-write tokens at their own rates.
 *
 * Data-dir / ledger resolution (first match wins):
 *   1. --ledger <file>   (analyze exactly this JSONL file + its `.1` sibling)
 *   2. --data-dir <dir>  (resolve <dir>/usage-ledger.jsonl)
 *   3. CYCLING_COACH_HOME env-var
 *   4. getCoachHome("cycling-coach")
 *
 * The tool never reads wall-clock time: every instant comes from the ledger or
 * the --since flag. It is a report with verdict exit codes (0 PASS / 2 REPRICE /
 * 3 UNDETERMINED / 1 operational error), not a CI gate.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { USAGE_LEDGER_FILE, type UsageLedgerLine } from "../packages/core/src/usage-ledger.js";
import { cacheBreakpointKey } from "../packages/core/src/llm.js";
import { PRICE_TABLE, type ModelCost } from "../packages/core/src/agent/codex/cost.js";
import { MS_PER_DAY } from "../packages/core/src/io/date-keys.js";
import { parseLedger, resolveDataDir, safeDiv } from "./usage-baseline.js";

export const BAND_MIN_CACHE_READ_RATIO = 0.6;
export const BAND_MAX_USD_PER_DAY = 0.25;
export const MIN_SOAK_DAYS = 7;
export const MAX_UNPRICED_TOKEN_SHARE = 0.1;

// ─── CLI ────────────────────────────────────────────────────────────────

export interface CliArgs {
  ledger?: string;
  dataDir?: string;
  sinceTs?: number;
  priceOverrides: Map<string, ModelCost>;
  json: boolean;
}

const PRICE_GRAMMAR = "<provider>:<model>=<input>/<output>/<cacheRead>/<cacheWrite>";

// Repeatable --price grammar. Splits on the FIRST `=`; the left side splits on
// the FIRST `:` (the model may itself contain `/`); the right side is exactly
// four `/`-separated non-negative finite numbers (USD per 1,000,000 tokens).
export function parsePriceFlag(value: string): { key: string; price: ModelCost } {
  const eq = value.indexOf("=");
  if (eq === -1) throw new Error(`--price: missing '=' (expected ${PRICE_GRAMMAR})`);
  const left = value.slice(0, eq);
  const right = value.slice(eq + 1);
  const colon = left.indexOf(":");
  if (colon === -1) throw new Error(`--price: missing ':' in '${left}' (expected ${PRICE_GRAMMAR})`);
  const provider = left.slice(0, colon);
  const model = left.slice(colon + 1);
  if (provider.length === 0 || model.length === 0) {
    throw new Error(`--price: empty provider or model in '${left}' (expected ${PRICE_GRAMMAR})`);
  }
  const parts = right.split("/");
  if (parts.length !== 4) {
    throw new Error(`--price: expected four '/'-separated numbers in '${right}' (${PRICE_GRAMMAR})`);
  }
  const nums = parts.map((part) => {
    if (part.trim().length === 0) {
      throw new Error(`--price: empty number in '${right}' (${PRICE_GRAMMAR})`);
    }
    const x = Number(part);
    if (!Number.isFinite(x) || x < 0) {
      throw new Error(`--price: '${part}' must be a non-negative finite number (${PRICE_GRAMMAR})`);
    }
    return x;
  });
  return {
    key: `${provider}:${model}`,
    price: { input: nums[0], output: nums[1], cacheRead: nums[2], cacheWrite: nums[3] },
  };
}

// Accepts both `--flag=value` and `--flag value`. Flags: --ledger, --data-dir,
// --since, --price (repeatable), --json.
export function parseCli(argv: readonly string[]): CliArgs {
  const out: CliArgs = { priceOverrides: new Map<string, ModelCost>(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) throw new Error(`unexpected positional arg: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
    const takeValue = (): string => {
      const fromNext = inlineVal === undefined;
      const val = fromNext ? argv[i + 1] : inlineVal;
      if (val === undefined || val.length === 0 || (fromNext && val.startsWith("--"))) {
        throw new Error(`flag --${key} requires a non-empty value`);
      }
      if (fromNext) i += 1;
      return val;
    };
    switch (key) {
      case "ledger":
        out.ledger = takeValue();
        break;
      case "data-dir":
        out.dataDir = takeValue();
        break;
      case "since": {
        const v = takeValue();
        const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
        if (!Number.isFinite(n)) {
          throw new Error(`--since must be epoch-ms or ISO-8601 (got '${v}')`);
        }
        out.sinceTs = n;
        break;
      }
      case "price": {
        const { key: priceKey, price } = parsePriceFlag(takeValue());
        out.priceOverrides.set(priceKey, price);
        break;
      }
      case "json":
        if (inlineVal !== undefined) throw new Error("flag --json takes no value");
        out.json = true;
        break;
      default:
        throw new Error(`unknown flag: ${tok}`);
    }
  }
  if (out.ledger !== undefined && out.dataDir !== undefined) {
    throw new Error("--ledger and --data-dir are mutually exclusive");
  }
  return out;
}

// ─── Ledger loading ─────────────────────────────────────────────────────

// Reads the rotated `.1` sibling FIRST (older data), then the live file. Returns
// the paths actually read (in read order) and their contents joined with "\n".
export function loadLedger(ledgerPath: string): { paths: string[]; raw: string } {
  const rotated = `${ledgerPath}.1`;
  const paths: string[] = [];
  const parts: string[] = [];
  if (existsSync(rotated)) {
    paths.push(rotated);
    parts.push(readFileSync(rotated, "utf-8"));
  }
  if (existsSync(ledgerPath)) {
    paths.push(ledgerPath);
    parts.push(readFileSync(ledgerPath, "utf-8"));
  }
  return { paths, raw: parts.join("\n") };
}

// ─── Metrics ──────────────────────────────────────────────────────────────

// Per-line cost recomputed from tokens. The ledger's own `cost` field is NEVER
// read: it prices the inclusive input at the full rate AND adds cache prices,
// double-billing cached tokens. Overrides win over the static catalog.
export function recomputeLineCostUsd(
  line: UsageLedgerLine,
  overrides: ReadonlyMap<string, ModelCost>,
): number | null {
  const price = overrides.get(`${line.provider}:${line.model}`) ?? PRICE_TABLE[line.provider]?.[line.model];
  if (!price) return null;
  const cacheRead = line.cacheReadTokens ?? 0;
  const cacheWrite = line.cacheWriteTokens ?? 0;
  const uncachedInput = Math.max(0, (line.inputTokens ?? 0) - cacheRead - cacheWrite);
  return (
    (price.input * uncachedInput +
      price.output * (line.outputTokens ?? 0) +
      price.cacheRead * cacheRead +
      price.cacheWrite * cacheWrite) /
    1_000_000
  );
}

// The cache-hit ratio is scoped to exactly the routes for which the LLM emits a
// cache breakpoint; the predicate is reused, never re-hardcoded.
export function isBreakpointCapableChatLine(line: UsageLedgerLine): boolean {
  return (
    line.kind === "generate" &&
    line.caller === "chat" &&
    cacheBreakpointKey(line.provider, line.model) !== undefined &&
    typeof line.inputTokens === "number" &&
    line.inputTokens > 0
  );
}

export interface BandReport {
  ledgerPaths: string[];
  ledgerSource: string;
  sinceTs: number | null;
  linesParsed: number;
  linesInWindow: number;
  window: { oldestTs: number | null; newestTs: number | null; spanDays: number | null };
  soakComplete: boolean;
  cacheHit: {
    eligibleLines: number;
    sumInputTokens: number;
    sumCacheReadTokens: number;
    ratio: number | null;
    allRoutesChatRatio: number | null;
    multiStepLines: number;
    multiStepLinesWithCacheRead: number;
    inclusivityViolations: number;
  };
  dailyCost: {
    generateLines: number;
    pricedLines: number;
    unpricedLines: number;
    unpricedTokenShare: number | null;
    recomputedTotalUsd: number;
    projectedUsdPerDay: number | null;
  };
  band: {
    minCacheReadRatio: number;
    maxUsdPerDay: number;
    minSoakDays: number;
    maxUnpricedTokenShare: number;
  };
  verdict: "PASS" | "REPRICE" | "UNDETERMINED";
  undeterminedReasons: string[];
}

export function buildBandReport(args: {
  ledgerPaths: string[];
  ledgerSource: string;
  raw: string;
  sinceTs: number | null;
  priceOverrides: ReadonlyMap<string, ModelCost>;
}): BandReport {
  const parsed = parseLedger(args.raw);
  const scoped = parsed.filter((l) => args.sinceTs === null || l.ts >= args.sinceTs);
  const generateLines = scoped.filter((l) => l.kind === "generate");

  let oldestTs: number | null = null;
  let newestTs: number | null = null;
  for (const g of generateLines) {
    if (oldestTs === null || g.ts < oldestTs) oldestTs = g.ts;
    if (newestTs === null || g.ts > newestTs) newestTs = g.ts;
  }
  const spanDays =
    oldestTs !== null && newestTs !== null ? (newestTs - oldestTs) / MS_PER_DAY : null;
  const soakComplete = spanDays !== null && spanDays >= MIN_SOAK_DAYS;

  const eligible = generateLines.filter(isBreakpointCapableChatLine);
  let sumInputTokens = 0;
  let sumCacheReadTokens = 0;
  let multiStepLines = 0;
  let multiStepLinesWithCacheRead = 0;
  let inclusivityViolations = 0;
  for (const e of eligible) {
    const input = e.inputTokens ?? 0;
    const cacheRead = e.cacheReadTokens ?? 0;
    const cacheWrite = e.cacheWriteTokens ?? 0;
    sumInputTokens += input;
    sumCacheReadTokens += cacheRead;
    if ((e.steps ?? 0) >= 2) {
      multiStepLines += 1;
      if (cacheRead > 0) multiStepLinesWithCacheRead += 1;
    }
    if (cacheRead + cacheWrite > input) inclusivityViolations += 1;
  }
  const ratio = safeDiv(sumCacheReadTokens, sumInputTokens);

  let allChatInput = 0;
  let allChatCacheRead = 0;
  for (const g of generateLines) {
    if (g.caller === "chat" && typeof g.inputTokens === "number" && g.inputTokens > 0) {
      allChatInput += g.inputTokens;
      allChatCacheRead += g.cacheReadTokens ?? 0;
    }
  }
  const allRoutesChatRatio = safeDiv(allChatCacheRead, allChatInput);

  let recomputedTotalUsd = 0;
  let pricedLines = 0;
  let unpricedLines = 0;
  let unpricedWeight = 0;
  let totalWeight = 0;
  for (const g of generateLines) {
    const weight = (g.inputTokens ?? 0) + (g.outputTokens ?? 0);
    totalWeight += weight;
    const cost = recomputeLineCostUsd(g, args.priceOverrides);
    if (cost !== null) {
      pricedLines += 1;
      recomputedTotalUsd += cost;
    } else {
      unpricedLines += 1;
      unpricedWeight += weight;
    }
  }
  const unpricedTokenShare = safeDiv(unpricedWeight, totalWeight);
  const projectedUsdPerDay =
    spanDays !== null && spanDays > 0 ? recomputedTotalUsd / spanDays : null;

  const undeterminedReasons: string[] = [];
  if (spanDays === null || spanDays < MIN_SOAK_DAYS) {
    undeterminedReasons.push("soak-window-below-minimum");
  }
  if (eligible.length === 0 || ratio === null) {
    undeterminedReasons.push("no-eligible-chat-lines");
  }
  if (inclusivityViolations > 0) {
    undeterminedReasons.push("inclusivity-violation");
  }

  let verdict: BandReport["verdict"];
  if (undeterminedReasons.length > 0) {
    verdict = "UNDETERMINED";
  } else if (ratio !== null && ratio < BAND_MIN_CACHE_READ_RATIO) {
    verdict = "REPRICE";
  } else if (
    unpricedTokenShare === null ||
    unpricedTokenShare > MAX_UNPRICED_TOKEN_SHARE ||
    projectedUsdPerDay === null
  ) {
    undeterminedReasons.push("unpriced-token-share-exceeds-threshold");
    verdict = "UNDETERMINED";
  } else if (projectedUsdPerDay > BAND_MAX_USD_PER_DAY) {
    verdict = "REPRICE";
  } else {
    verdict = "PASS";
  }

  return {
    ledgerPaths: args.ledgerPaths,
    ledgerSource: args.ledgerSource,
    sinceTs: args.sinceTs,
    linesParsed: parsed.length,
    linesInWindow: scoped.length,
    window: { oldestTs, newestTs, spanDays },
    soakComplete,
    cacheHit: {
      eligibleLines: eligible.length,
      sumInputTokens,
      sumCacheReadTokens,
      ratio,
      allRoutesChatRatio,
      multiStepLines,
      multiStepLinesWithCacheRead,
      inclusivityViolations,
    },
    dailyCost: {
      generateLines: generateLines.length,
      pricedLines,
      unpricedLines,
      unpricedTokenShare,
      recomputedTotalUsd,
      projectedUsdPerDay,
    },
    band: {
      minCacheReadRatio: BAND_MIN_CACHE_READ_RATIO,
      maxUsdPerDay: BAND_MAX_USD_PER_DAY,
      minSoakDays: MIN_SOAK_DAYS,
      maxUnpricedTokenShare: MAX_UNPRICED_TOKEN_SHARE,
    },
    verdict,
    undeterminedReasons,
  };
}

export function verdictExitCode(v: BandReport["verdict"]): 0 | 2 | 3 {
  return v === "PASS" ? 0 : v === "REPRICE" ? 2 : 3;
}

// ─── Formatting ───────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtIso(ts: number | null): string {
  return ts === null ? "—" : new Date(ts).toISOString();
}

function fmtUsd(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(4)}`;
}

export function formatHuman(report: BandReport): string {
  const out: string[] = [];
  out.push("usage:cache-band");
  out.push(`  ledger: ${report.ledgerPaths.join(", ")}  (via ${report.ledgerSource})`);
  out.push(
    `  window: ${fmtIso(report.window.oldestTs)} .. ${fmtIso(report.window.newestTs)} ` +
      `(${report.window.spanDays === null ? "—" : report.window.spanDays.toFixed(2)} days, ` +
      `soak ${report.soakComplete ? "complete" : "incomplete"} at >= ${report.band.minSoakDays} days)`,
  );
  out.push(`  lines: parsed ${report.linesParsed}  in-window ${report.linesInWindow}`);
  out.push("");
  out.push("cache-read ratio (chat role, breakpoint-capable routes)");
  out.push(
    `  eligible lines: ${report.cacheHit.eligibleLines}  ` +
      `cache-read ${report.cacheHit.sumCacheReadTokens} / input ${report.cacheHit.sumInputTokens} tokens`,
  );
  out.push(
    `  ratio: ${fmtPct(report.cacheHit.ratio)}  band: >= ${(report.band.minCacheReadRatio * 100).toFixed(0)}%`,
  );
  out.push(
    `  multi-step cache evidence: ${report.cacheHit.multiStepLinesWithCacheRead}/${report.cacheHit.multiStepLines} ` +
      `multi-step chat generations carried cache-read tokens`,
  );
  out.push(`  all-routes chat ratio (disclosure): ${fmtPct(report.cacheHit.allRoutesChatRatio)}`);
  out.push(`  inclusivity violations: ${report.cacheHit.inclusivityViolations}`);
  out.push("");
  out.push("daily cost (all generations, token-recomputed)");
  out.push(
    `  generate lines: ${report.dailyCost.generateLines}  ` +
      `priced ${report.dailyCost.pricedLines} / unpriced ${report.dailyCost.unpricedLines}  ` +
      `(unpriced token share ${fmtPct(report.dailyCost.unpricedTokenShare)})`,
  );
  out.push(
    `  recomputed total: ${fmtUsd(report.dailyCost.recomputedTotalUsd)}  ` +
      `projected: ${report.dailyCost.projectedUsdPerDay === null ? "—" : `${fmtUsd(report.dailyCost.projectedUsdPerDay)}/day`}  ` +
      `band: <= $${report.band.maxUsdPerDay.toFixed(2)}/day`,
  );
  out.push("");
  for (const reason of report.undeterminedReasons) {
    out.push(`  reason: ${reason}`);
  }
  out.push(`VERDICT: ${report.verdict}`);
  return out.join("\n");
}

// ─── Entry ────────────────────────────────────────────────────────────────

export function run(argv: readonly string[]): number {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    console.error(`usage:cache-band: ${(err as Error).message}`);
    return 1;
  }

  let ledgerPath: string;
  let ledgerSource: string;
  if (args.ledger !== undefined) {
    ledgerPath = args.ledger;
    ledgerSource = "--ledger";
  } else {
    const { dir, source } = resolveDataDir(args.dataDir);
    ledgerPath = join(dir, USAGE_LEDGER_FILE);
    ledgerSource = source;
  }

  const { paths, raw } = loadLedger(ledgerPath);
  if (paths.length === 0) {
    console.error(`usage:cache-band: no ledger at ${ledgerPath}`);
    return 1;
  }

  const report = buildBandReport({
    ledgerPaths: paths,
    ledgerSource,
    raw,
    sinceTs: args.sinceTs ?? null,
    priceOverrides: args.priceOverrides,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(report)}\n`);
  }
  return verdictExitCode(report.verdict);
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  process.exit(run(process.argv.slice(2)));
}
