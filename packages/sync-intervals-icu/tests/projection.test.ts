import { describe, expect, it } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  validateReferenceCaptureManifest,
  type RecordRef,
  type ReferenceCaptureManifest,
  type SnapshotRef,
} from "@enduragent/kernel/reference/capture";
import type { SelectedGenericRow, SelectedSourceRow, SourceArtifactRow } from "@enduragent/kernel/ingest";
import type { VerifiedSnapshotReader } from "@enduragent/kernel/reference/local-bundle";
import { decodeLocalBundleProjection, type LocalBundleSelectedEvidence } from "../src/projection.js";

const hex = (value: number): string => value.toString(16).padStart(64, "0");
const ref = (value: number): SnapshotRef => ({ address: hex(value), rel_path: `1998/06/${hex(value)}.json.gz` });
const revision = (value: number) => ({ source_record_id: hex(value), revision_id: hex(value + 100) });

const activityRows = [
  { id: "a", start_date_local: "1998-06-04T08:00:00", type: "Run", moving_time: 60, elapsed_time: 61, icu_training_load: 10 },
  { id: "b", start_date_local: "1998-06-05T08:00:00", type: "Ride", moving_time: 70, elapsed_time: 71, icu_training_load: 10 },
];
const wellnessRows = [
  { id: "1998-06-04", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null,
    sportInfo: [{ type: "Ride", eftp: 250.4 }] },
  { id: "1998-06-05", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null,
    sportInfo: [{ type: "Ride", eftp: 251.6 }] },
];
const settingsRows = [
  { id: 1, athlete_id: "synthetic", types: ["\uE000"], updated: "1998-06-04T00:00:00.000Z" },
  { id: 1, athlete_id: "synthetic", types: ["𐀀"], updated: "1998-06-04T00:00:00.000Z" },
  { id: 2, athlete_id: "synthetic", types: ["a"], updated: "1998-06-04T00:00:00.000Z" },
  { id: 2, athlete_id: "synthetic", types: ["aa"], updated: "1998-06-04T00:00:00.000Z" },
];

function settingExternal(row: (typeof settingsRows)[number]): string {
  return `settings:${canonicalJson([row.id, row.athlete_id, row.types, row.updated])}`;
}

interface Fixture {
  manifest: ReferenceCaptureManifest;
  evidence: LocalBundleSelectedEvidence;
  values: Map<string, unknown>;
  calls: string[];
  reader: VerifiedSnapshotReader;
}

function record(
  ordinal: number,
  endpointOrdinal: number,
  payloadIndex: number | null,
  externalId: string,
  snapshot: SnapshotRef,
  artifactKey: string,
  currentRevision: ReturnType<typeof revision> | null,
): RecordRef {
  return { ordinal, endpoint_ordinal: endpointOrdinal, payload_index: payloadIndex, external_id: externalId,
    snapshot, store_evidence: { artifact_key: artifactKey, current_revision: currentRevision } };
}

function fixture(): Fixture {
  const endpointRefs = [ref(1), ref(2), ref(3), ref(40)];
  const settingRecords = settingsRows.map((row, index) => record(index, 0, index, settingExternal(row), ref(10 + index),
    hex(200 + index), revision(300 + index)));
  const activityRecords = [
    record(0, 1, 0, "a", ref(20), hex(220), revision(320)),
    record(1, 1, 1, "b", ref(21), hex(221), revision(321)),
  ];
  const wellnessRecords = [
    record(0, 2, 0, "1998-06-04", ref(30), hex(230), null),
    record(1, 2, 1, "1998-06-05", ref(31), hex(231), null),
  ];
  const streamRecords = [record(0, 3, null, "streams:b", endpointRefs[3]!, hex(240), revision(340))];
  const captureEpoch = Date.UTC(1998, 5, 10);
  const manifest = validateReferenceCaptureManifest({
    schema_version: 1,
    capture_id: "123e4567-e89b-42d3-a456-426614174000",
    source: "external-oracle",
    plan: {
      capture_epoch_ms: captureEpoch,
      frozenNow: "1998-06-10T12:00:00",
      window: { oldest: "1998-06-01", newest: "1998-06-10" },
      stream_cutoff_epoch_ms: captureEpoch - 21 * 24 * 60 * 60 * 1_000,
    },
    operation_ledger: { link_kind: "capture-id", capture_id: "123e4567-e89b-42d3-a456-426614174000" },
    endpoints: [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile",
        request: { oldest: null, newest: null, activity_id: null, stream_types: [], include_defaults: null }, snapshot: endpointRefs[0] },
      { ordinal: 1, lane: "activities", endpoint: "activities",
        request: { oldest: "1998-06-01", newest: "1998-06-10", activity_id: null, stream_types: [], include_defaults: null }, snapshot: endpointRefs[1] },
      { ordinal: 2, lane: "wellness", endpoint: "wellness",
        request: { oldest: "1998-06-01", newest: "1998-06-10", activity_id: null, stream_types: [], include_defaults: null }, snapshot: endpointRefs[2] },
      { ordinal: 3, lane: "streams", endpoint: "activity-streams",
        request: { oldest: null, newest: null, activity_id: "b",
          stream_types: ["time", "watts", "heartrate", "dfa_a1", "artifacts"], include_defaults: false }, snapshot: endpointRefs[3] },
    ],
    records: { settings: settingRecords, activities: activityRecords, wellness: wellnessRecords, streams: streamRecords },
    selected_stream_ids: ["b"], captured_stream_ids: ["b"],
    deterministic_order: {
      endpoint_ordinals: [0, 1, 2, 3], settings: settingRecords.map((item) => item.external_id),
      activities: ["a", "b"], wellness: ["1998-06-04", "1998-06-05"], streams: ["b"],
    },
  });
  const values = new Map<string, unknown>();
  for (const endpoint of manifest.endpoints) values.set(endpoint.snapshot.address, { verified: endpoint.ordinal });
  manifest.records.settings.forEach((item, index) => values.set(item.snapshot.address, settingsRows[index]));
  manifest.records.activities.forEach((item, index) => values.set(item.snapshot.address, activityRows[index]));
  manifest.records.wellness.forEach((item, index) => values.set(item.snapshot.address, wellnessRows[index]));
  values.set(manifest.records.streams[0]!.snapshot.address, { time: [0, 1], dfaA1: [0.8, 0.7] });
  const calls: string[] = [];
  const reader: VerifiedSnapshotReader = { async readVerifiedSnapshot(snapshot) {
    calls.push(snapshot.address);
    if (!values.has(snapshot.address)) throw new Error("missing synthetic snapshot");
    return structuredClone(values.get(snapshot.address));
  } };
  const activityEvidence: SelectedSourceRow[] = manifest.records.activities.map((item, index) => ({
    id: item.store_evidence.current_revision!.source_record_id, workout_key: null, session_key: null,
    source: "intervals-icu", external_id: item.external_id, raw_sha256: item.snapshot.address,
    quality_rank: 300, payload_json: canonicalJson({ activity: activityRows[index], concerns: {}, dedup: {}, schema_version: 1 }),
    revision_id: item.store_evidence.current_revision!.revision_id, artifact_key: item.store_evidence.artifact_key,
    archive_address: item.snapshot.address, archive_rel_path: item.snapshot.rel_path, archive_epoch_s: 1,
  }));
  const generic = (items: readonly RecordRef[], rows: readonly Record<string, unknown>[], endpoint: "settings" | "streams"):
    SelectedGenericRow[] => items.map((item, index) => ({
      source_record_id: item.store_evidence.current_revision!.source_record_id,
      external_id: item.external_id, revision_id: item.store_evidence.current_revision!.revision_id,
      payload_json: canonicalJson({ endpoint, landing: rows[index], schema_version: 1 }),
      artifact_key: item.store_evidence.artifact_key, archive_address: item.snapshot.address,
      archive_rel_path: item.snapshot.rel_path, archive_epoch_s: 1,
    }));
  const wellnessEvidence: SourceArtifactRow[] = manifest.records.wellness.map((item) => ({
    artifact_key: item.store_evidence.artifact_key, source: "intervals-icu", lane: "wellness",
    external_id: item.external_id, archive_address: item.snapshot.address,
    archive_rel_path: item.snapshot.rel_path, archive_epoch_s: 1,
  }));
  const evidence: LocalBundleSelectedEvidence = {
    activities: [...activityEvidence].reverse(),
    settings: generic(manifest.records.settings, settingsRows, "settings").reverse(),
    wellness: [...wellnessEvidence, { ...wellnessEvidence[0]!, artifact_key: hex(999), external_id: "1998-06-04" }].reverse(),
    streams: generic(manifest.records.streams, [{ time: [0, 1], dfa_a1: [0.8, 0.7] }], "streams"),
  };
  return { manifest, evidence, values, calls, reader };
}

describe("local bundle projection", () => {
  it("verifies in protocol order, uses manifest order, supersedes settings, and omits unsupported families", async () => {
    const input = fixture();
    const bundle = await decodeLocalBundleProjection(input.manifest, input.evidence, input.reader);
    expect(input.calls).toEqual([
      ...input.manifest.endpoints.map((item) => item.snapshot.address),
      ...input.manifest.records.settings.map((item) => item.snapshot.address),
      ...input.manifest.records.activities.map((item) => item.snapshot.address),
      ...input.manifest.records.wellness.map((item) => item.snapshot.address),
      ...input.manifest.records.streams.map((item) => item.snapshot.address),
    ]);
    expect(bundle.activities.map((activity) => activity.id)).toEqual(["a", "b"]);
    expect(bundle.wellness.map((day) => day.id)).toEqual(["1998-06-04", "1998-06-05"]);
    expect(bundle.ftpHistory).toEqual([
      { date: "1998-06-04", ftp: 250, source: "estimate" },
      { date: "1998-06-05", ftp: 252, source: "estimate" },
    ]);
    expect(bundle.streams).toEqual({ b: { time: [0, 1], dfa_a1: [0.8, 0.7] } });
    expect(bundle.athlete!.sportSettings.map((row) => ({ id: row.id, types: row.types }))).toEqual([
      { id: 1, types: ["𐀀"] }, { id: 2, types: ["aa"] },
    ]);
    for (const key of ["powerCurves", "hrCurves", "sustainabilityCurves", "currentFtpIndoor", "currentFtpOutdoor",
      "ftpHistoryIndoor", "ftpHistoryOutdoor", "eftp"]) expect(bundle).not.toHaveProperty(key);
  });

  it("subsets activities and streams only through the filter seam", async () => {
    const input = fixture();
    const bundle = await decodeLocalBundleProjection(input.manifest, input.evidence, input.reader, (activity) => activity.id === "a");
    expect(bundle.activities.map((activity) => activity.id)).toEqual(["a"]);
    expect(bundle.streams).toEqual({});
    expect(bundle.wellness).toHaveLength(2);
  });

  it("fails closed on current-revision drift without falling back", async () => {
    const input = fixture();
    const activities = input.evidence.activities.map((row) => row.external_id === "a" ? { ...row, revision_id: hex(998) } : row);
    await expect(decodeLocalBundleProjection(input.manifest, { ...input.evidence, activities }, input.reader)).rejects.toThrow(/absent or ambiguous/);
  });

  for (const direction of ["persisted", "decoded"] as const) {
    it(`rejects ${direction}-only activity evidence changes`, async () => {
      const input = fixture();
      if (direction === "persisted") {
        const activities = input.evidence.activities.map((row) => row.external_id === "a"
          ? { ...row, payload_json: canonicalJson({ activity: { ...activityRows[0], icu_training_load: 11 }, concerns: {}, dedup: {}, schema_version: 1 }) } : row);
        input.evidence = { ...input.evidence, activities };
      } else input.values.set(input.manifest.records.activities[0]!.snapshot.address, { ...activityRows[0], icu_training_load: 11 });
      await expect(decodeLocalBundleProjection(input.manifest, input.evidence, input.reader)).rejects.toThrow("activity source evidence mismatch");
    });

    it(`rejects ${direction}-only stream evidence changes`, async () => {
      const input = fixture();
      if (direction === "persisted") input.evidence = { ...input.evidence, streams: input.evidence.streams.map((row) => ({
        ...row, payload_json: canonicalJson({ endpoint: "streams", landing: { time: [0, 2], dfa_a1: [0.8, 0.7] }, schema_version: 1 }),
      })) };
      else input.values.set(input.manifest.records.streams[0]!.snapshot.address, { time: [0, 2], dfaA1: [0.8, 0.7] });
      await expect(decodeLocalBundleProjection(input.manifest, input.evidence, input.reader)).rejects.toThrow("streams source evidence mismatch");
    });

    it(`rejects ${direction}-only settings evidence changes`, async () => {
      const input = fixture();
      if (direction === "persisted") input.evidence = { ...input.evidence, settings: input.evidence.settings.map((row) =>
        row.external_id === settingExternal(settingsRows[0]!) ? { ...row, payload_json: canonicalJson({ endpoint: "settings",
          landing: { ...settingsRows[0], types: ["changed"] }, schema_version: 1 }) } : row) };
      else input.values.set(input.manifest.records.settings[0]!.snapshot.address, { ...settingsRows[0], types: ["changed"] });
      await expect(decodeLocalBundleProjection(input.manifest, input.evidence, input.reader)).rejects.toThrow("settings source evidence mismatch");
    });
  }

  it("reports invalid setting candidates as PROJECTION_FAILED", async () => {
    const input = fixture();
    input.values.set(input.manifest.records.settings[0]!.snapshot.address, { ...settingsRows[0], id: -1 });
    const changed = { ...settingsRows[0], id: -1 };
    input.evidence = { ...input.evidence, settings: input.evidence.settings.map((row) =>
      row.external_id === settingExternal(settingsRows[0]!) ? { ...row,
        payload_json: canonicalJson({ endpoint: "settings", landing: changed, schema_version: 1 }) } : row) };
    await expect(decodeLocalBundleProjection(input.manifest, input.evidence, input.reader)).rejects.toMatchObject({ code: "PROJECTION_FAILED" });
  });
});
