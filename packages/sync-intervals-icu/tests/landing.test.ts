import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import { createIntervalsSourceRepository, sortKeys, type Row, type SqlStore } from "@enduragent/kernel/store";
import { mapActivityLanding, mapSettingsLanding, mapWellnessLanding, normalizeStreamLanding } from "../src/index.js";

const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");

describe("intervals.icu landing mappings", () => {
  it("maps exact activity concerns and dedup without invented samples", async () => {
    const activity = { id: 7, start_date: "1998-01-05T07:00:00Z", start_date_local: "1998-01-05T08:00:00",
      type: "Ride", moving_time: 90, elapsed_time: 100, distance: 1_000, name: "synthetic" };
    const address = "a".repeat(64), relPath = `1998/01/${address}.json.gz`;
    const value = await mapActivityLanding({ normalized: activity, archiveInstant: { epochSeconds: 884_000_000 },
      archive: { address, relPath, deduped: false } });
    expect(value.activity_id).toBe("7");
    expect(value.dedup).toEqual({ sport_family: "cycling", is_transition: false,
      start_utc: Date.parse(activity.start_date) / 1_000, duration_s: 100, distance_m: 1_000 });
    expect(value.concerns).toEqual({ "session.sport": "cycling", "session.start_utc": Date.parse(activity.start_date) / 1_000,
      "session.local_date_key": 19980105, "session.elapsed_s": 100, "session.moving_s": 90,
      "session.distance_m": 1_000, "session.is_transition": false, "session.summary_json": JSON.stringify(sortKeys(activity)),
      "stream:time": { timestamps: [Date.parse(activity.start_date) / 1_000, Date.parse(activity.start_date) / 1_000 + 100],
        values: [Date.parse(activity.start_date) / 1_000, Date.parse(activity.start_date) / 1_000 + 100] } });
    expect(value.sourceEvidence).toMatchObject({ externalId: "7", normalizedActivityJson: canonicalJson(activity) });
    expect(Object.keys(value.concerns).filter((key) => key.startsWith("stream:")).some((key) => key !== "stream:time")).toBe(false);
  });

  it("maps wellness columns and manual wellness wins", async () => {
    const value = await mapWellnessLanding({ id: "1998-01-05", restingHR: 48, hrv: 71.5, hrvSdnn: 40,
      sleepSecs: 28_800, sleepQuality: 4, weight: 70.2, soreness: 1, fatigue: 2, updated: "1998-01-05T09:00:00Z" });
    expect(value).toMatchObject({ date_key: 19980105, resting_hr: 48, hrv: 71.5, hrv_sdnn: 40,
      sleep_s: 28_800, sleep_score: 4, weight_kg: 70.2, soreness: 1, fatigue: 2,
      provenance: "sync", source: "intervals-icu" });
    expect(JSON.parse(value.fields_json)).toMatchObject({ source: "intervals-icu", values: { updated: "1998-01-05T09:00:00Z" } });
    const run = vi.fn(async () => {});
    const store: SqlStore = { exec: async () => {}, run,
      get: async (sql): Promise<Row | undefined> => sql.includes("FROM wellness")
        ? { id: "manual", date_key: 19980105, provenance: "manual", source: null } : undefined,
      all: async () => [], close: async () => {} };
    await expect(createIntervalsSourceRepository(store, hashKey).upsertWellness(value)).resolves.toBe("manual-wins");
    expect(run).not.toHaveBeenCalled();
  });

  it("maps sport settings to synced anchors and zones while retaining unsupported pace fields source-only", async () => {
    const raw = { id: 9, athlete_id: "synthetic-athlete", types: ["Run", "Ride"], updated: "1998-01-05T09:00:00Z",
      ftp: 250, lthr: 170, max_hr: 190, power_zones: [100, 200], power_zone_names: ["low", "high"],
      hr_zones: [120, 160], hr_zone_names: ["easy", "hard"], indoor_ftp: 240,
      threshold_pace: 250, pace_units: "seconds", pace_zones: [300, 270] };
    const value = await mapSettingsLanding(raw);
    expect(value.externalId).toBe(canonicalJson([9, "synthetic-athlete", ["Run", "Ride"], "1998-01-05T09:00:00Z"]));
    expect(value.anchors).toContainEqual(expect.objectContaining({ sport: "cycling", anchor_type: "ftp", value: 250,
      unit: "W", source: "intervals-icu", provenance: "sync", confidence: "platform" }));
    expect(value.anchors).not.toContainEqual(expect.objectContaining({ sport: "run", anchor_type: "ftp" }));
    expect(value.zones).toContainEqual(expect.objectContaining({ sport: "cycling", stream: "power", anchor_ref: "ftp",
      boundaries_json: canonicalJson({ boundaries: [100, 200], names: ["low", "high"] }) }));
    expect(JSON.parse(value.normalizedPayloadJson)).toMatchObject({ indoor_ftp: 240, threshold_pace: 250,
      pace_units: "seconds", pace_zones: [300, 270] });
    expect(value.anchors.some((row) => row.anchor_type.includes("pace"))).toBe(false);
    expect(value.zones.some((row) => row.stream === ("pace" as never))).toBe(false);
  });

  it("validates stream landing channels and equal lengths", () => {
    expect(normalizeStreamLanding({ time: [0, 1], watts: [100, null], dfa_a1: [0.9, 0.8], ignored: [1] }))
      .toEqual({ time: [0, 1], watts: [100, null], dfa_a1: [0.9, 0.8] });
    expect(() => normalizeStreamLanding({ time: [0], watts: [100, 101] })).toThrow("lengths differ");
    expect(() => normalizeStreamLanding({ time: [Number.NaN] })).toThrow("channel is invalid");
  });
});
