import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openSqliteStorage } from "../../kernel-node/src/sqlite/index.js";
import { canonicalJson } from "../src/archive/index.js";
import { QUALITY_RANK } from "../src/ingest/quality-rank.js";
import {
  assertReferenceCaptureReplayable,
  createReferenceCapturePlan,
  parseReferenceCaptureManifest,
  parseReferenceCapturePlan,
  planCalendarTimeZone,
  referenceCaptureClock,
  selectReferenceCaptureStreamIds,
  serializeReferenceCaptureManifest,
  serializeReferenceCapturePlan,
  validateReferenceCaptureManifest,
  type DerivedCaptureMembers,
  type ReferenceCaptureManifest,
} from "../src/reference/capture.js";
import { createIntervalsSourceRepository, runMigrations, type SourceRecordRow } from "../src/store/index.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";

const ADDRESS = "a".repeat(64);
const ARTIFACT = "b".repeat(64);
const RECORD = "c".repeat(64);
const REVISION = "d".repeat(64);
const CAPTURE_ID = "12345678-1234-4123-8123-123456789abc";
const NOW = new Date("1998-07-18T12:34:56.789Z");
const hashKey = async (fields: readonly (string | number)[]): Promise<string> =>
  createHash("sha256").update(fields.join("\u001f")).digest("hex");

function snapshot() { return { address: ADDRESS, rel_path: `1998/07/${ADDRESS}.json.gz` }; }

function manifest(): ReferenceCaptureManifest {
  const plan = createReferenceCapturePlan({ now: NOW, calendarTimeZone: "UTC" });
  return validateReferenceCaptureManifest({
    schema_version: 1, capture_id: CAPTURE_ID, source: "external-oracle", plan,
    operation_ledger: { link_kind: "capture-id", capture_id: CAPTURE_ID },
    endpoints: [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile", request: { oldest: null, newest: null,
        activity_id: null, stream_types: [], include_defaults: null }, snapshot: snapshot() },
      { ordinal: 1, lane: "activities", endpoint: "activities", request: { oldest: plan.window.oldest,
        newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, snapshot: snapshot() },
      { ordinal: 2, lane: "wellness", endpoint: "wellness", request: { oldest: plan.window.oldest,
        newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, snapshot: snapshot() },
      { ordinal: 3, lane: "streams", endpoint: "activity-streams", request: { oldest: null, newest: null,
        activity_id: "42", stream_types: ["time", "watts", "heartrate", "dfa_a1", "artifacts"],
        include_defaults: false }, snapshot: snapshot() },
    ],
    records: {
      settings: [{ ordinal: 0, endpoint_ordinal: 0, payload_index: 1, external_id: "settings:one", snapshot: snapshot(),
        store_evidence: { artifact_key: ARTIFACT, current_revision: { source_record_id: RECORD, revision_id: REVISION } } }],
      activities: [{ ordinal: 0, endpoint_ordinal: 1, payload_index: 2, external_id: "42", snapshot: snapshot(),
        store_evidence: { artifact_key: ARTIFACT, current_revision: { source_record_id: RECORD, revision_id: REVISION } } }],
      wellness: [{ ordinal: 0, endpoint_ordinal: 2, payload_index: 0, external_id: "1998-07-17", snapshot: snapshot(),
        store_evidence: { artifact_key: ARTIFACT, current_revision: null } }],
      streams: [{ ordinal: 0, endpoint_ordinal: 3, payload_index: null, external_id: "streams:42", snapshot: snapshot(),
        store_evidence: { artifact_key: ARTIFACT, current_revision: { source_record_id: RECORD, revision_id: REVISION } } }],
    },
    selected_stream_ids: ["99", "42"], captured_stream_ids: ["42"],
    deterministic_order: { endpoint_ordinals: [0, 1, 2, 3], settings: ["settings:one"], activities: ["42"],
      wellness: ["1998-07-17"], streams: ["42"] },
  });
}

describe("Reference capture plan and manifest", () => {
  it("round-trips a stored v1 plan through canonical JSON without adding a timezone", () => {
    const stored = {
      capture_epoch_ms: NOW.getTime(),
      frozenNow: "1998-07-18T12:34:56",
      stream_cutoff_epoch_ms: NOW.getTime() - 21 * 86_400_000,
      window: { newest: "1998-07-18", oldest: "1998-04-25" },
    };
    const bytes = `${canonicalJson(stored)}\n`;
    const parsed = parseReferenceCapturePlan(bytes);
    expect(canonicalJson(parsed)).toBe(canonicalJson(stored));
    expect(Object.hasOwn(parsed, "calendar_timezone")).toBe(false);
    expect(planCalendarTimeZone(parsed)).toBe("UTC");
  });

  it("owns one clock and exact canonical bytes", () => {
    const plan = createReferenceCapturePlan({ now: NOW, calendarTimeZone: "UTC" });
    expect(plan.capture_epoch_ms).toBe(NOW.getTime());
    expect(plan.stream_cutoff_epoch_ms).toBe(NOW.getTime() - 21 * 86_400_000);
    expect(plan.frozenNow).toMatch(/^1998-07-18T/);
    expect(parseReferenceCapturePlan(serializeReferenceCapturePlan(plan))).toEqual(plan);
    expect(() =>
      createReferenceCapturePlan({ now: new Date(Number.NaN), calendarTimeZone: "UTC" }),
    ).toThrow();
    expect(() => parseReferenceCapturePlan(`${serializeReferenceCapturePlan(plan)} `)).toThrow();
  });

  it("uses the requested calendar timezone for the civil capture window", () => {
    const now = new Date("1998-07-18T20:30:00.000Z");
    const utc = createReferenceCapturePlan({ now, calendarTimeZone: "UTC" });
    const almaty = createReferenceCapturePlan({ now, calendarTimeZone: "Asia/Almaty" });
    expect(utc.window).toEqual({ oldest: "1998-04-25", newest: "1998-07-18" });
    expect(almaty.window).toEqual({ oldest: "1998-04-26", newest: "1998-07-19" });
    expect(almaty.frozenNow).toBe("1998-07-19T03:30:00");
    expect(planCalendarTimeZone(almaty)).toBe("Asia/Almaty");
  });

  it("projects the authoritative instant, civil time, and calendar zone together", () => {
    const plan = createReferenceCapturePlan({
      now: new Date("1998-07-18T20:30:00.000Z"),
      calendarTimeZone: "Asia/Almaty",
    });
    expect(referenceCaptureClock(plan)).toEqual({
      captureEpochMs: Date.parse("1998-07-18T20:30:00.000Z"),
      civilDateTime: "1998-07-19T03:30:00",
      calendarTimeZone: "Asia/Almaty",
    });
  });

  it("strictly validates every manifest object and exact bytes", () => {
    const value = manifest(), bytes = serializeReferenceCaptureManifest(value);
    expect(parseReferenceCaptureManifest(bytes)).toEqual(value);
    expect(() => parseReferenceCaptureManifest(bytes.trim())).toThrow();
    expect(() => validateReferenceCaptureManifest({ ...value, extra: true })).toThrow();
    expect(() => validateReferenceCaptureManifest({ ...value,
      records: { ...value.records, activities: [{ ...value.records.activities[0]!, store_evidence: {
        ...value.records.activities[0]!.store_evidence, current_revision: null } }] } })).toThrow();
  });

  it("selects by parsed time then encounter index without key ordering", () => {
    const plan = createReferenceCapturePlan({ now: NOW, calendarTimeZone: "UTC" });
    const same = new Date(plan.capture_epoch_ms - 1_000).toISOString();
    expect(selectReferenceCaptureStreamIds([
      { id: "z", type: "Ride", start_date_local: same },
      { id: "a", type: "VirtualRide", start_date_local: same },
      { id: "run", type: "Run", start_date_local: same },
      { id: "z", type: "Ride", start_date_local: new Date(plan.capture_epoch_ms).toISOString() },
    ], plan)).toEqual(["z", "a"]);
  });
});

describe("assertReferenceCaptureReplayable", () => {
  function derived(): DerivedCaptureMembers {
    return { settings: [{ endpoint_ordinal: 0, payload_index: 1, external_id: "settings:one", payload: { setting: 1 } }],
      activities: [{ endpoint_ordinal: 1, payload_index: 2, external_id: "42", payload: { activity: 1 } }],
      wellness: [{ endpoint_ordinal: 2, payload_index: 0, external_id: "1998-07-17", payload: { wellness: 1 } }],
      streams: [{ endpoint_ordinal: 3, payload_index: null, external_id: "streams:42", payload: { stream: 1 } }],
      selected_stream_ids: ["99", "42"] };
  }
  it("reads every reference, derives once, and checks every pinned record", async () => {
    const value = manifest(), payloads = [{}, {}, {}, {}, { setting: 1 }, { activity: 1 }, { wellness: 1 }, { stream: 1 }];
    const read = vi.fn(async () => payloads.shift()), derive = vi.fn(async () => derived()), evidence = vi.fn(async () => {});
    await assertReferenceCaptureReplayable(value, { readVerifiedSnapshot: read, derivePayloadMembers: derive,
      assertStoreEvidence: evidence });
    expect(read).toHaveBeenCalledTimes(8);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveBeenCalledTimes(4);
  });

  it("rejects missing, permuted, and byte-different members", async () => {
    const value = manifest();
    const run = (changed: DerivedCaptureMembers) => {
      const payloads = [{}, {}, {}, {}, { setting: 1 }, { activity: 1 }, { wellness: 1 }, { stream: 1 }];
      return assertReferenceCaptureReplayable(value, { readVerifiedSnapshot: async () => payloads.shift(),
        derivePayloadMembers: async () => changed, assertStoreEvidence: async () => {} });
    };
    await expect(run({ ...derived(), activities: [] })).rejects.toThrow();
    await expect(run({ ...derived(), activities: [{ ...derived().activities[0]!, payload: { activity: 2 } }] })).rejects.toThrow();
    await expect(run({ ...derived(), selected_stream_ids: ["42", "99"] })).rejects.toThrow();
  });

  it("rejects a derived lane whose members jointly permute manifest record order", async () => {
    const base = manifest();
    const value = validateReferenceCaptureManifest({ ...base, records: { ...base.records,
      activities: [base.records.activities[0]!, { ...base.records.activities[0]!, ordinal: 1,
        payload_index: 3, external_id: "43" }] },
    deterministic_order: { ...base.deterministic_order, activities: ["42", "43"] } });
    const payloads = [{}, {}, {}, {}, { setting: 1 }, { activity: 1 }, { activity: 2 }, { wellness: 1 }, { stream: 1 }];
    const members = derived();
    await expect(assertReferenceCaptureReplayable(value, { readVerifiedSnapshot: async () => payloads.shift(),
      derivePayloadMembers: async () => ({ ...members, activities: [
        { endpoint_ordinal: 1, payload_index: 3, external_id: "43", payload: { activity: 2 } },
        members.activities[0]!,
      ] }), assertStoreEvidence: async () => {} })).rejects.toThrow("capture membership differs");
  });

  it("fails the whole replay when one pinned evidence assertion rejects", async () => {
    const payloads = [{}, {}, {}, {}, { setting: 1 }, { activity: 1 }, { wellness: 1 }, { stream: 1 }];
    const evidence = vi.fn(async (_record, lane) => {
      if (lane === "activities") throw new Error("mismatched evidence");
    });
    await expect(assertReferenceCaptureReplayable(manifest(), { readVerifiedSnapshot: async () => payloads.shift(),
      derivePayloadMembers: async () => derived(), assertStoreEvidence: evidence })).rejects.toThrow("mismatched evidence");
    expect(evidence).toHaveBeenCalledTimes(2);
  });

  it("rejects null and present revisions for the wrong pinned evidence lanes", async () => {
    const store = openSqliteStorage(":memory:");
    try {
      await runMigrations(store, MIGRATIONS);
      const repository = createIntervalsSourceRepository(store, hashKey);
      const activityAddress = "e".repeat(64);
      const activityArtifact = await repository.recordArtifact({ source: "intervals-icu", lane: "activities",
        externalId: "42", artifactKind: "snapshot", archiveAddress: activityAddress,
        archiveRelPath: `1998/07/${activityAddress}.json.gz`, archiveEpochSeconds: 899_424_000 });
      await expect(repository.assertPinnedCaptureEvidence({ lane: "activities", externalId: "42",
        artifactKey: activityArtifact.artifactKey, archiveAddress: activityAddress,
        archiveRelPath: `1998/07/${activityAddress}.json.gz`, currentRevision: null })).rejects.toThrow("revision is absent");

      const wellnessAddress = "f".repeat(64);
      const wellnessArtifact = await repository.recordArtifact({ source: "intervals-icu", lane: "wellness",
        externalId: "1998-07-17", artifactKind: "snapshot", archiveAddress: wellnessAddress,
        archiveRelPath: `1998/07/${wellnessAddress}.json.gz`, archiveEpochSeconds: 899_424_000 });
      await expect(repository.assertPinnedCaptureEvidence({ lane: "wellness", externalId: "1998-07-17",
        artifactKey: wellnessArtifact.artifactKey, archiveAddress: wellnessAddress,
        archiveRelPath: `1998/07/${wellnessAddress}.json.gz`,
        currentRevision: { sourceRecordId: RECORD, revisionId: REVISION } })).rejects.toThrow("must be null");
    } finally {
      await store.close();
    }
  });

  it("accepts pinned evidence after a later activity revision becomes current", async () => {
    const store = openSqliteStorage(":memory:");
    try {
      await runMigrations(store, MIGRATIONS);
      const repository = createIntervalsSourceRepository(store, hashKey);
      const firstAddress = "e".repeat(64), secondAddress = "f".repeat(64);
      const firstArtifact = await repository.recordArtifact({ source: "intervals-icu", lane: "activities",
        externalId: "42", artifactKind: "snapshot", archiveAddress: firstAddress,
        archiveRelPath: `1998/07/${firstAddress}.json.gz`, archiveEpochSeconds: 899_424_000 });
      const firstRow: SourceRecordRow = { id: RECORD, workout_key: null, session_key: null, source: "intervals-icu",
        external_id: "42", raw_sha256: firstAddress, quality_rank: QUALITY_RANK.PLATFORM_API,
        payload_json: canonicalJson({ activity: { version: 1 }, concerns: {}, dedup: {}, schema_version: 1 }) };
      await repository.applyActivityRevision({ sourceRow: firstRow, artifactKey: firstArtifact.artifactKey });
      const pinned = await repository.readCurrentCaptureEvidence("activities", "42");

      const secondArtifact = await repository.recordArtifact({ source: "intervals-icu", lane: "activities",
        externalId: "42", artifactKind: "snapshot", archiveAddress: secondAddress,
        archiveRelPath: `1998/07/${secondAddress}.json.gz`, archiveEpochSeconds: 899_510_400 });
      await repository.applyActivityRevision({ sourceRow: { ...firstRow, raw_sha256: secondAddress,
        payload_json: canonicalJson({ activity: { version: 2 }, concerns: {}, dedup: {}, schema_version: 1 }) },
      artifactKey: secondArtifact.artifactKey });
      expect((await repository.readCurrentCaptureEvidence("activities", "42")).revisionId).not.toBe(pinned.revisionId);
      await expect(repository.assertPinnedCaptureEvidence({ lane: "activities", externalId: "42",
        artifactKey: pinned.artifactKey, archiveAddress: pinned.archiveAddress, archiveRelPath: pinned.archiveRelPath,
        currentRevision: { sourceRecordId: pinned.sourceRecordId, revisionId: pinned.revisionId } })).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
