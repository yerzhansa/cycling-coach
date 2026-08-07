import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReferenceBundle } from "@enduragent/kernel/reference/local-bundle";
import {
  ANALYTICS_CURVE_PARTS,
  H,
  analyticsCurveWindows,
  createAnalyticsCurveRepository,
  runMigrations,
  type AnalyticsCurveState,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createArchiveManager } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  PowerProgressProjectionError,
  createPowerProgressStateSource,
  projectPowerProgressPanel,
  projectPowerProgressState,
} from "../src/power-progress.js";

const FROZEN_ON = "2026-08-07";
const FROZEN_AT = `${FROZEN_ON}T12:00:00.000Z`;
const FROZEN_EPOCH_SECONDS = Date.parse(FROZEN_AT) / 1_000;
const WINDOWS = analyticsCurveWindows(FROZEN_ON);
const CURRENT = `r.${WINDOWS.current.start}.${WINDOWS.current.end}`;
const PREVIOUS = `r.${WINDOWS.previous.start}.${WINDOWS.previous.end}`;
const SUSTAINABILITY = `r.${WINDOWS.sustainability.start}.${WINDOWS.sustainability.end}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function current(): NonNullable<AnalyticsCurveState["current"]> {
  return {
    generation: {
      generationId: "a".repeat(64),
      frozenEpochSeconds: FROZEN_EPOCH_SECONDS,
      frozenOn: FROZEN_ON,
      windows: WINDOWS,
    },
    evidence: [],
    promotedEpochSeconds: FROZEN_EPOCH_SECONDS,
  };
}

function power(id: string, secs: number[], watts: number[]) {
  return { id, secs, watts };
}

function heartRate(id: string, secs: number[], values: number[]) {
  return { id, secs, values };
}

function curves(): Pick<ReferenceBundle, "powerCurves" | "hrCurves" | "sustainabilityCurves"> {
  const powerSecs = [5, 60, 300, 1_200, 3_600];
  const heartRateSecs = [60, 300, 1_200, 3_600];
  const sustainabilitySecs = [300, 600, 1_200, 3_600];
  return {
    powerCurves: {
      list: [
        power(CURRENT, powerSecs, [1_100, 500, 350, 280, 240]),
        power(PREVIOUS, powerSecs, [900, 480, 330, 260, 230]),
      ],
    },
    hrCurves: {
      list: [
        heartRate(CURRENT, heartRateSecs, [180, 176, 165, 150]),
        heartRate(PREVIOUS, heartRateSecs, [175, 170, 160, 148]),
      ],
    },
    sustainabilityCurves: {
      cycling: {
        power: {
          Ride: {
            list: [power(SUSTAINABILITY, sustainabilitySecs, [360, 330, 285, 245])],
          },
          VirtualRide: {
            list: [power(SUSTAINABILITY, sustainabilitySecs, [370, 320, 275, 235])],
          },
        },
        hr: {
          Ride: {
            list: [heartRate(SUSTAINABILITY, sustainabilitySecs, [175, 170, 165, 150])],
          },
          VirtualRide: {
            list: [heartRate(SUSTAINABILITY, sustainabilitySecs, [176, 169, 164, 149])],
          },
        },
      },
    },
  };
}

function providerPayloads() {
  const powerSecs = [5, 60, 300, 600, 1_200, 3_600];
  const heartRateSecs = [60, 300, 600, 1_200, 3_600];
  return [
    {
      activities: {},
      list: [
        { id: CURRENT, secs: powerSecs, values: [1_000, 500, 350, 330, 280, 240] },
        { id: PREVIOUS, secs: powerSecs, values: [900, 480, 330, 310, 260, 230] },
        { id: SUSTAINABILITY, secs: powerSecs, values: [1_000, 500, 360, 330, 285, 245] },
      ],
    },
    {
      activities: {},
      list: [
        { id: CURRENT, secs: powerSecs, values: [1_100, 490, 340, 320, 275, 235] },
        { id: PREVIOUS, secs: powerSecs, values: [880, 470, 320, 300, 250, 220] },
        { id: SUSTAINABILITY, secs: powerSecs, values: [1_100, 490, 370, 320, 275, 235] },
      ],
    },
    {
      activities: {},
      list: [
        { id: CURRENT, secs: heartRateSecs, values: [180, 175, 170, 165, 150] },
        { id: PREVIOUS, secs: heartRateSecs, values: [175, 170, 165, 160, 148] },
        { id: SUSTAINABILITY, secs: heartRateSecs, values: [180, 175, 170, 165, 150] },
      ],
    },
    {
      activities: {},
      list: [
        { id: CURRENT, secs: heartRateSecs, values: [178, 176, 169, 164, 149] },
        { id: PREVIOUS, secs: heartRateSecs, values: [173, 169, 164, 159, 147] },
        { id: SUSTAINABILITY, secs: heartRateSecs, values: [178, 176, 169, 164, 149] },
      ],
    },
  ] as const;
}

describe("Power Progress state projection", () => {
  it("projects exact bounded power anchors with secondary HR and sustainability context", () => {
    const result = projectPowerProgressPanel({
      current: current(),
      curves: curves(),
      nowEpochMilliseconds: Date.parse(FROZEN_AT),
    });

    expect(result).toMatchObject({
      kind: "computed",
      currentWindow: WINDOWS.current,
      previousWindow: WINDOWS.previous,
      rotation: "sprint",
      freshness: "fresh",
      asOf: FROZEN_AT,
      heartRateContext: { kind: "computed" },
      sustainabilityContext: {
        kind: "computed",
        window: WINDOWS.sustainability,
        sourceContext: "mixed",
      },
    });
    expect(result.anchors.map((anchor) => anchor.durationSeconds)).toEqual([
      5, 60, 300, 1_200, 3_600,
    ]);
    expect(result.anchors[0]).toEqual({
      durationSeconds: 5,
      current: { kind: "computed", watts: 1_100 },
      previous: { kind: "computed", watts: 900 },
      change: { kind: "computed", percent: 22.2 },
    });
    expect(
      result.heartRateContext.kind === "computed" && result.heartRateContext.anchors[1]?.current,
    ).toEqual({ kind: "computed", bpm: 176 });
  });

  it("keeps curve freshness independent from base state and wraps a failed refresh as stale", () => {
    const selected: AnalyticsCurveState = {
      current: current(),
      refreshFailure: {
        generationId: "b".repeat(64),
        code: "timeout",
        failedEpochSeconds: FROZEN_EPOCH_SECONDS + 3_600,
      },
    };
    const result = projectPowerProgressState({
      state: selected,
      curves: curves(),
      nowEpochMilliseconds: Date.parse(FROZEN_AT) + 8 * 86_400_000,
    });

    expect(result).toMatchObject({
      kind: "stale",
      lastGood: { kind: "computed", freshness: "critical" },
      refreshFailure: { code: "timeout", failedAt: "2026-08-07T13:00:00.000Z" },
    });
  });

  it("returns stable unavailable reasons when no promoted generation exists", () => {
    expect(
      projectPowerProgressState({
        state: { current: null, refreshFailure: null },
        nowEpochMilliseconds: Date.parse(FROZEN_AT),
      }),
    ).toEqual({ kind: "unavailable", reason: "not-synced" });
    expect(
      projectPowerProgressState({
        state: {
          current: null,
          refreshFailure: {
            generationId: "b".repeat(64),
            code: "network",
            failedEpochSeconds: FROZEN_EPOCH_SECONDS,
          },
        },
        nowEpochMilliseconds: Date.parse(FROZEN_AT),
      }),
    ).toEqual({ kind: "unavailable", reason: "refresh-failed" });
  });

  it("fails closed when the exact prior power window is absent", () => {
    const selected = curves();
    const malformed = {
      ...selected,
      powerCurves: { list: selected.powerCurves!.list.slice(0, 1) },
    };
    expect(() =>
      projectPowerProgressPanel({
        current: current(),
        curves: malformed,
        nowEpochMilliseconds: Date.parse(FROZEN_AT),
      }),
    ).toThrow(new PowerProgressProjectionError());
  });

  it("reads verified persisted evidence and retains it after a later failed generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "power-progress-state-"));
    roots.push(root);
    const archiveRoot = join(root, "archive");
    await mkdir(archiveRoot, { mode: 0o700 });
    const store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    const crypto = createNodeCrypto();
    const archive = createArchiveManager({ archiveRoot, crypto, fs: nodeFileSystem() });
    const repository = createAnalyticsCurveRepository(store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(crypto, ...(fields as [string | number, ...(string | number)[]]));
    });

    try {
      const { generation } = await repository.beginGeneration({
        frozenEpochSeconds: FROZEN_EPOCH_SECONDS,
        frozenOn: FROZEN_ON,
      });
      let firstArchivePath = "";
      for (const [index, part] of ANALYTICS_CURVE_PARTS.entries()) {
        const payload = providerPayloads()[index]!;
        const persisted = await archive.writeSnapshot(payload, {
          epochSeconds: FROZEN_EPOCH_SECONDS,
        });
        if (firstArchivePath.length === 0) {
          firstArchivePath = join(archiveRoot, persisted.relPath);
        }
        await repository.recordEvidence({
          generationId: generation.generationId,
          ...part,
          archiveAddress: persisted.address,
          archiveRelPath: persisted.relPath,
          archiveEpochSeconds: FROZEN_EPOCH_SECONDS,
          decodedBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
        });
      }
      await repository.promoteGeneration({
        generationId: generation.generationId,
        promotedEpochSeconds: FROZEN_EPOCH_SECONDS,
      });
      let now = Date.parse(FROZEN_AT);
      const source = createPowerProgressStateSource({ store, archiveRoot, now: () => now });
      await expect(source.readPowerProgress()).resolves.toMatchObject({
        kind: "computed",
        freshness: "fresh",
      });

      now += 86_400_000;
      const failed = await repository.beginGeneration({
        frozenEpochSeconds: FROZEN_EPOCH_SECONDS + 86_400,
        frozenOn: "2026-08-08",
      });
      await repository.recordRefreshFailure({
        generationId: failed.generation.generationId,
        code: "network",
        failedEpochSeconds: FROZEN_EPOCH_SECONDS + 86_400,
      });
      const stale = await source.readPowerProgress();
      expect(stale).toMatchObject({
        kind: "stale",
        lastGood: { kind: "computed", asOf: FROZEN_AT },
        refreshFailure: { code: "network", failedAt: "2026-08-08T12:00:00.000Z" },
      });
      expect(JSON.stringify(stale)).not.toMatch(/generationId|archive|\.json\.gz/);
      await rm(firstArchivePath);
      await expect(source.readPowerProgress()).resolves.toEqual({
        kind: "unavailable",
        reason: "invalid-data",
      });
    } finally {
      await store.close();
    }
  });
});
