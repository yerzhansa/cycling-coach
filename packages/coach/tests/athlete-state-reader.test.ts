import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AthleteStateSchema } from "@enduragent/coach-contract";
import {
  ERROR_STATE_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
} from "@enduragent/kernel/reference/schemas";
import {
  AthleteStateUnavailableError,
  createPersistedAthleteStateSource,
} from "../src/athlete-state-reader.js";

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-athlete-state-"));
  roots.push(root);
  await mkdir(join(root, "data"));
  return root;
}

function latest(freshness: "fresh" | "flag" | "stale" | "critical" = "fresh") {
  return {
    metadata: {
      schema_version: LATEST_SCHEMA_VERSION,
      last_updated: "2026-07-18T00:00:00.000Z",
      freshness,
    },
    athlete_profile: { name: "Synthetic Athlete" },
    current_status: { summary: "ready" },
    derived_metrics: {
      eftp: 250,
      acwr: 1.2,
      "capability.dfa_a1_profile": { value: 0.7 },
      future_metric: { value: 1 },
    },
    derived_metrics_meta: {
      sportFamily: "cycling",
      prescriptionBasis: "power",
      anchorType: "ftp",
      analysisBasis: "power",
    },
    recent_activities: [{ id: "activity-1" }],
    planned_workouts: [{ id: "workout-1" }],
    wellness_data: { restingHr: 45 },
  };
}

function errorState(mitigation: "block_coaching" | "warn_only" = "warn_only") {
  return {
    schema_version: ERROR_STATE_SCHEMA_VERSION,
    step: "synthetic",
    detail: "synthetic outage",
    ts: "2026-07-18T01:00:00.000Z",
    mitigation,
  };
}

async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(root, "data", name), JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted athlete state source", () => {
  it("maps every persisted field into a contract-valid state", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest());
    await writeJson(root, "error_state.json", errorState());
    const state = await createPersistedAthleteStateSource({ dataDir: root }).getAthleteState();
    expect(AthleteStateSchema.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      schemaVersion: LATEST_SCHEMA_VERSION,
      lastUpdated: "2026-07-18T00:00:00.000Z",
      lastSynced: "2026-07-18T00:00:00.000Z",
      freshness: "fresh",
      degraded: false,
      athleteProfile: { name: "Synthetic Athlete" },
      currentStatus: { summary: "ready" },
      recentActivities: [{ id: "activity-1" }],
      plannedWorkouts: [{ id: "workout-1" }],
      wellness: { restingHr: 45 },
    });
  });

  it("removes both reveal-fenced keys and preserves future metric keys", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest());
    const state = await createPersistedAthleteStateSource({ dataDir: root }).getAthleteState();
    expect(state.derivedMetrics).toEqual({ eftp: 250, future_metric: { value: 1 } });
    expect(Object.hasOwn(state.derivedMetrics, "acwr")).toBe(false);
    expect(Object.hasOwn(state.derivedMetrics, "capability.dfa_a1_profile")).toBe(false);
  });

  it("retains the prior latest bytes and marks block-coaching degradation", async () => {
    const root = await home();
    await writeJson(root, "latest.json", latest("flag"));
    await writeJson(root, "error_state.json", errorState("block_coaching"));
    const state = await createPersistedAthleteStateSource({ dataDir: root }).getAthleteState();
    expect(state.degraded).toBe(true);
    expect(state.freshness).toBe("flag");
    expect(state.currentStatus).toEqual({ summary: "ready" });
    expect(state.plannedWorkouts).toEqual([{ id: "workout-1" }]);
    expect(state.lastSynced).toBe(state.lastUpdated);
  });

  it("fails open for every absent, malformed, invalid, or mismatched error sidecar", async () => {
    const variants: unknown[] = [undefined, "{", { no: "schema" }, {
      ...errorState("block_coaching"),
      schema_version: "different",
    }];
    for (const variant of variants) {
      const root = await home();
      await writeJson(root, "latest.json", latest());
      if (variant !== undefined) {
        await writeFile(
          join(root, "data", "error_state.json"),
          typeof variant === "string" ? variant : JSON.stringify(variant),
        );
      }
      await expect(createPersistedAthleteStateSource({ dataDir: root }).getAthleteState())
        .resolves.toMatchObject({ degraded: false });
    }
  });

  it("preserves all persisted freshness bands despite later file timestamps", async () => {
    for (const freshness of ["fresh", "flag", "stale", "critical"] as const) {
      const root = await home();
      await writeJson(root, "latest.json", latest(freshness));
      const future = new Date("2030-01-01T00:00:00.000Z");
      await utimes(join(root, "data", "latest.json"), future, future);
      await expect(createPersistedAthleteStateSource({ dataDir: root }).getAthleteState())
        .resolves.toMatchObject({ freshness });
    }
  });

  it("throws the stable unavailable error for absent, invalid, and wrong-version latest", async () => {
    const variants: unknown[] = [undefined, "{", latest(), {
      ...latest(),
      metadata: { ...latest().metadata, schema_version: "different" },
    }];
    (variants[2] as ReturnType<typeof latest>).metadata.freshness = "invalid" as never;
    for (const variant of variants) {
      const root = await home();
      if (variant !== undefined) {
        await writeFile(
          join(root, "data", "latest.json"),
          typeof variant === "string" ? variant : JSON.stringify(variant),
        );
      }
      await expect(createPersistedAthleteStateSource({ dataDir: root }).getAthleteState())
        .rejects.toEqual(new AthleteStateUnavailableError("No validated athlete state is available."));
    }
  });

  it("reads a single persisted pair per call without exposing file paths or schema issues", async () => {
    const root = await home();
    const selected = latest();
    await writeJson(root, "latest.json", selected);
    await writeJson(root, "error_state.json", errorState());
    const source = createPersistedAthleteStateSource({ dataDir: root });
    const first = await source.getAthleteState();
    selected.current_status = { summary: "changed" };
    await writeJson(root, "latest.json", selected);
    const second = await source.getAthleteState();
    expect(first.currentStatus).toEqual({ summary: "ready" });
    expect(second.currentStatus).toEqual({ summary: "changed" });
    const unavailableRoot = await home();
    const failure = await createPersistedAthleteStateSource({ dataDir: unavailableRoot })
      .getAthleteState().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AthleteStateUnavailableError);
    expect(String(failure)).not.toContain(unavailableRoot);
    expect(String(failure)).not.toContain("Zod");
  });
});
