import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { makeIntervalsHttpFactory } from "@enduragent/core";
import {
  H,
  createAnalyticsCurveRepository,
  type PhysicalRequestLedger,
  type SyncBudget,
} from "@enduragent/kernel/store";
import { createArchiveManager } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import {
  refreshAnalyticsCurves,
  type AnalyticsCurveRefreshOutcome,
} from "@enduragent/sync-intervals-icu";
import { DEFAULT_REQUEST_INTERVAL_MS } from "./backfill.js";
import { withCoachStoreWriter, type CoachStoreWriterContext } from "./runtime.js";

export interface RunAnalyticsCurveRefreshOptions {
  readonly env: Record<string, string | undefined>;
  readonly writerContext?: CoachStoreWriterContext;
  readonly apiKey: string;
  readonly athleteId: string;
  readonly frozenAt: Date;
  readonly budget: SyncBudget;
  readonly attemptLedger: PhysicalRequestLedger;
  readonly baseFetch?: typeof globalThis.fetch;
}

export interface RunAnalyticsCurveRefreshDependencies {
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function runAnalyticsCurveRefresh(
  options: RunAnalyticsCurveRefreshOptions,
  dependencies: RunAnalyticsCurveRefreshDependencies = {},
): Promise<AnalyticsCurveRefreshOutcome> {
  const frozenEpochMs = options.frozenAt.getTime();
  if (
    !Number.isSafeInteger(frozenEpochMs) ||
    frozenEpochMs < 0 ||
    frozenEpochMs > 8_640_000_000_000_000
  ) {
    throw new TypeError("analytics curve frozen instant is invalid");
  }
  const sleep =
    dependencies.sleep ??
    ((ms: number, signal: AbortSignal) =>
      setTimeoutPromise(ms, undefined, { signal }).then(() => undefined));

  const refresh = async ({ home, store }: CoachStoreWriterContext) => {
    const crypto = createNodeCrypto();
    const archive = createArchiveManager({
      archiveRoot: home.archiveDir,
      crypto,
      fs: nodeFileSystem(),
    });
    const repository = createAnalyticsCurveRepository(store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(crypto, ...(fields as [string | number, ...(string | number)[]]));
    });
    return refreshAnalyticsCurves({
      athleteId: options.athleteId,
      minRequestIntervalMs: DEFAULT_REQUEST_INTERVAL_MS,
      httpFactory: makeIntervalsHttpFactory({
        apiKey: options.apiKey,
        ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
      }),
      archive,
      repository,
      attemptLedger: options.attemptLedger,
      wallClock: { now: () => frozenEpochMs },
      sleep,
      budget: options.budget,
    });
  };

  return options.writerContext === undefined
    ? withCoachStoreWriter(options.env, refresh)
    : refresh(options.writerContext);
}
