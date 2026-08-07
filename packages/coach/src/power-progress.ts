import {
  PowerProgressPanelSchema,
  type PowerProgressComputed,
  type PowerProgressPanel,
} from "@enduragent/coach-contract";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import {
  CRITICAL_MS,
  FRESH_MS,
  FUTURE_TOLERANCE_MS,
  STALE_MS,
} from "@enduragent/kernel/reference/freshness";
import {
  buildMetricInput,
  type ReferenceBundle,
  type VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import {
  computeHrCurveDelta,
  computePowerCurveDelta,
  computeSustainabilityProfile,
  type HrCurveAnchor,
  type PowerCurveAnchor,
  type SustainabilitySportBlock,
} from "@enduragent/kernel/reference/metrics";
import {
  H,
  createAnalyticsCurveStateReader,
  type AnalyticsCurveState,
  type SqlReadStore,
} from "@enduragent/kernel/store";
import { createVerifiedSnapshotReader } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import {
  AnalyticsCurveProjectionError,
  projectAnalyticsCurveEvidence,
} from "@enduragent/sync-intervals-icu";

const POWER_ANCHORS = [
  [5, "5s"],
  [60, "60s"],
  [300, "300s"],
  [1_200, "1200s"],
  [3_600, "3600s"],
] as const;

const HEART_RATE_ANCHORS = [
  [60, "60s"],
  [300, "300s"],
  [1_200, "1200s"],
  [3_600, "3600s"],
] as const;

export class PowerProgressProjectionError extends Error {
  readonly code = "POWER_PROGRESS_PROJECTION_FAILED";

  constructor() {
    super("power progress could not be projected");
    this.name = "PowerProgressProjectionError";
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface PowerProgressStateSource {
  readPowerProgress(): Promise<PowerProgressPanel>;
}

export interface PowerProgressStateSourceOptions {
  readonly store: SqlReadStore;
  readonly archiveRoot: string;
  readonly now?: () => number;
}

export interface PowerProgressStateSourceDependencies {
  readonly crypto?: () => CryptoPort;
  readonly fileSystem?: () => FileSystemPort;
  readonly createSnapshotReader?: (dependencies: {
    readonly archiveRoot: string;
    readonly crypto: CryptoPort;
    readonly fs: FileSystemPort;
  }) => VerifiedSnapshotReader;
}

type ProjectedCurves = Pick<ReferenceBundle, "powerCurves" | "hrCurves" | "sustainabilityCurves">;

function invalidProjection(): never {
  throw new PowerProgressProjectionError();
}

function exactWindow(
  actual: { readonly start: string; readonly end: string } | undefined,
  expected: { readonly start: string; readonly end: string },
): boolean {
  return actual?.start === expected.start && actual.end === expected.end;
}

function freshnessAt(frozenEpochSeconds: number, nowEpochMilliseconds: number) {
  const frozenMs = frozenEpochSeconds * 1_000;
  if (
    !Number.isSafeInteger(frozenEpochSeconds) ||
    frozenEpochSeconds < 0 ||
    !Number.isSafeInteger(nowEpochMilliseconds) ||
    nowEpochMilliseconds < 0
  ) {
    invalidProjection();
  }
  const elapsed = nowEpochMilliseconds - frozenMs;
  if (elapsed < -FUTURE_TOLERANCE_MS) return "stale" as const;
  if (elapsed >= CRITICAL_MS) return "critical" as const;
  if (elapsed >= STALE_MS) return "stale" as const;
  if (elapsed >= FRESH_MS) return "flag" as const;
  return "fresh" as const;
}

function watts(value: number | null) {
  return value === null
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "computed", watts: value } as const);
}

function bpm(value: number | null) {
  return value === null
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "computed", bpm: value } as const);
}

function change(value: number | null) {
  return value === null
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "computed", percent: value } as const);
}

function powerAnchor(durationSeconds: number, value: PowerCurveAnchor | undefined) {
  if (value === undefined) invalidProjection();
  return {
    durationSeconds,
    current: watts(value.current_watts),
    previous: watts(value.previous_watts),
    change: change(value.pct_change),
  };
}

function heartRateAnchor(durationSeconds: number, value: HrCurveAnchor | undefined) {
  if (value === undefined) invalidProjection();
  return {
    durationSeconds,
    current: bpm(value.current_bpm),
    previous: bpm(value.previous_bpm),
    change: change(value.pct_change),
  };
}

function rotation(value: number | null): PowerProgressComputed["rotation"] {
  if (value === null) return "unknown";
  if (!Number.isFinite(value)) invalidProjection();
  if (value > 0) return "sprint";
  if (value < 0) return "endurance";
  return "balanced";
}

function sourceContext(
  block: SustainabilitySportBlock,
): "indoor" | "outdoor" | "mixed" | "unknown" {
  if (block.anchors === null) return "unknown";
  let indoor = false;
  let outdoor = false;
  for (const anchor of Object.values(block.anchors)) {
    if (anchor.source === null) continue;
    if (anchor.source === "observed_indoor") indoor = true;
    else if (anchor.source === "observed_outdoor") outdoor = true;
    else invalidProjection();
  }
  if (indoor && outdoor) return "mixed";
  if (indoor) return "indoor";
  if (outdoor) return "outdoor";
  return "unknown";
}

function projectPowerProgressPanelUnchecked(input: {
  readonly current: NonNullable<AnalyticsCurveState["current"]>;
  readonly curves: ProjectedCurves;
  readonly nowEpochMilliseconds: number;
}): PowerProgressComputed {
  const generation = input.current.generation;
  const metricInput = buildMetricInput(
    {
      activities: [],
      wellness: [],
      ftpHistory: [],
      ...input.curves,
    },
    `${generation.frozenOn}T12:00:00.000Z`,
  );
  const power = computePowerCurveDelta(metricInput);
  if (
    power.window_days !== 28 ||
    power.anchors === null ||
    !exactWindow(power.current_window, generation.windows.current) ||
    !exactWindow(power.previous_window, generation.windows.previous)
  ) {
    invalidProjection();
  }

  const heartRate = computeHrCurveDelta(metricInput);
  const heartRateContext =
    heartRate.window_days === 28 &&
    heartRate.anchors !== null &&
    exactWindow(heartRate.current_window, generation.windows.current) &&
    exactWindow(heartRate.previous_window, generation.windows.previous)
      ? {
          kind: "computed" as const,
          anchors: HEART_RATE_ANCHORS.map(([durationSeconds, key]) =>
            heartRateAnchor(durationSeconds, heartRate.anchors?.[key]),
          ),
        }
      : ({ kind: "unavailable", reason: "insufficient-data" } as const);

  const sustainability = computeSustainabilityProfile(metricInput);
  const cycling = sustainability.cycling;
  const sustainabilityContext =
    sustainability.window !== undefined &&
    exactWindow(sustainability.window, generation.windows.sustainability) &&
    cycling !== undefined &&
    cycling !== null &&
    typeof cycling === "object" &&
    "coverage_ratio" in cycling
      ? {
          kind: "computed" as const,
          window: generation.windows.sustainability,
          coverageRatio: (cycling as SustainabilitySportBlock).coverage_ratio,
          sourceContext: sourceContext(cycling as SustainabilitySportBlock),
        }
      : ({ kind: "unavailable", reason: "insufficient-data" } as const);

  const asOf = new Date(generation.frozenEpochSeconds * 1_000).toISOString();
  const parsed = PowerProgressPanelSchema.safeParse({
    kind: "computed",
    currentWindow: generation.windows.current,
    previousWindow: generation.windows.previous,
    anchors: POWER_ANCHORS.map(([durationSeconds, key]) =>
      powerAnchor(durationSeconds, power.anchors?.[key]),
    ),
    rotation: rotation(power.rotation_index),
    heartRateContext,
    sustainabilityContext,
    freshness: freshnessAt(generation.frozenEpochSeconds, input.nowEpochMilliseconds),
    asOf,
  });
  if (!parsed.success || parsed.data.kind !== "computed") invalidProjection();
  return parsed.data;
}

export function projectPowerProgressPanel(
  input: Parameters<typeof projectPowerProgressPanelUnchecked>[0],
): PowerProgressComputed {
  try {
    return projectPowerProgressPanelUnchecked(input);
  } catch (error) {
    if (error instanceof PowerProgressProjectionError) throw error;
    throw new PowerProgressProjectionError();
  }
}

function unavailable(
  reason: "not-synced" | "invalid-data" | "refresh-failed" | "temporary-failure",
) {
  return PowerProgressPanelSchema.parse({ kind: "unavailable", reason });
}

export function projectPowerProgressState(input: {
  readonly state: AnalyticsCurveState;
  readonly curves?: ProjectedCurves;
  readonly nowEpochMilliseconds: number;
}): PowerProgressPanel {
  if (input.state.current === null) {
    return unavailable(input.state.refreshFailure === null ? "not-synced" : "refresh-failed");
  }
  if (input.curves === undefined) invalidProjection();
  const computed = projectPowerProgressPanel({
    current: input.state.current,
    curves: input.curves,
    nowEpochMilliseconds: input.nowEpochMilliseconds,
  });
  if (input.state.refreshFailure === null) return computed;
  return PowerProgressPanelSchema.parse({
    kind: "stale",
    lastGood: computed,
    refreshFailure: {
      code: input.state.refreshFailure.code,
      failedAt: new Date(input.state.refreshFailure.failedEpochSeconds * 1_000).toISOString(),
    },
  });
}

export function createPowerProgressStateSource(
  options: PowerProgressStateSourceOptions,
  dependencies: PowerProgressStateSourceDependencies = {},
): PowerProgressStateSource {
  if (
    options === null ||
    typeof options !== "object" ||
    options.store === null ||
    typeof options.store !== "object" ||
    typeof options.archiveRoot !== "string" ||
    options.archiveRoot.length === 0
  ) {
    throw new TypeError("power progress source options are invalid");
  }
  const crypto = (dependencies.crypto ?? createNodeCrypto)();
  const snapshots = (dependencies.createSnapshotReader ?? createVerifiedSnapshotReader)({
    archiveRoot: options.archiveRoot,
    crypto,
    fs: (dependencies.fileSystem ?? nodeFileSystem)(),
  });
  const state = createAnalyticsCurveStateReader(options.store, (fields) => {
    if (fields.length === 0) throw new TypeError("empty key tuple");
    return H(crypto, ...(fields as [string | number, ...(string | number)[]]));
  });
  const now = options.now ?? Date.now;

  return Object.freeze({
    async readPowerProgress(): Promise<PowerProgressPanel> {
      try {
        const selected = await state.readState();
        if (selected.current === null)
          return projectPowerProgressState({
            state: selected,
            nowEpochMilliseconds: now(),
          });
        const curves = await projectAnalyticsCurveEvidence(selected.current, snapshots);
        return projectPowerProgressState({
          state: selected,
          curves,
          nowEpochMilliseconds: now(),
        });
      } catch (error) {
        return unavailable(
          error instanceof AnalyticsCurveProjectionError ||
            error instanceof PowerProgressProjectionError
            ? "invalid-data"
            : "temporary-failure",
        );
      }
    },
  });
}
