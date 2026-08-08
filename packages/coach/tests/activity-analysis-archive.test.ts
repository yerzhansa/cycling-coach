import { describe, expect, it, vi } from "vitest";
import {
  createProviderActivityBestEffortsArchive,
  createProviderActivityIntervalsArchive,
  createProviderActivityStreamArchive,
} from "../src/activity-analysis-archive.js";

const REVISION = "a".repeat(64);
const ADDRESS = "b".repeat(64);
const ARTIFACT = "c".repeat(64);

function setup(input: { readonly abortAfterArchive?: AbortController } = {}) {
  const events: string[] = [];
  const snapshots: unknown[] = [];
  const artifactDrafts: unknown[] = [];
  const landingDrafts: unknown[] = [];
  const store = {
    exec: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    all: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    async transaction<T>(work: () => Promise<T>): Promise<T> {
      events.push("transaction:start");
      const value = await work();
      events.push("transaction:end");
      return value;
    },
  };
  const dependencies = {
    archive: {
      async writeSnapshot(snapshot: unknown) {
        events.push("archive");
        snapshots.push(snapshot);
        input.abortAfterArchive?.abort();
        return { address: ADDRESS, relPath: `1998/07/${ADDRESS}.json.gz`, deduped: false };
      },
    },
    store,
    sources: {
      async recordArtifact(draft: unknown) {
        events.push("artifact");
        artifactDrafts.push(draft);
        return { artifactKey: ARTIFACT, inserted: true };
      },
      async recordGenericLanding(draft: unknown) {
        events.push("landing");
        landingDrafts.push(draft);
        return true;
      },
    },
    runExclusive: async <T>(work: () => Promise<T>): Promise<T> => {
      events.push("exclusive");
      return work();
    },
    now: () => Date.parse("1998-07-06T12:00:00.000Z"),
  };
  const archive = createProviderActivityStreamArchive(dependencies);
  return { archive, dependencies, events, snapshots, artifactDrafts, landingDrafts };
}

describe("provider activity stream archive", () => {
  it("writes private evidence before publishing its bounded landing record", async () => {
    const state = setup();
    await state.archive.write({
      sourceRevision: REVISION,
      descriptors: [
        { type: "time", data: [0, 1] },
        { type: "watts", data: [200, 201] },
      ],
      signal: new AbortController().signal,
    });

    expect(state.events).toEqual([
      "archive",
      "exclusive",
      "transaction:start",
      "artifact",
      "landing",
      "transaction:end",
    ]);
    expect(state.snapshots[0]).toMatchObject({
      schema_version: 1,
      source_revision: REVISION,
      descriptors: [
        { type: "time", data: [0, 1] },
        { type: "watts", data: [200, 201] },
      ],
    });
    expect(state.artifactDrafts[0]).toMatchObject({
      lane: "streams",
      archiveAddress: ADDRESS,
      externalId: `streams:analysis:${REVISION}:${ADDRESS}`,
    });
    expect(state.landingDrafts[0]).toMatchObject({
      externalId: `streams:analysis:${REVISION}:${ADDRESS}`,
      artifactKey: ARTIFACT,
    });
    expect(JSON.stringify(state.landingDrafts[0])).not.toContain("200");
  });

  it("keeps interval and effort values private while publishing only bounded counts", async () => {
    const intervals = setup();
    await createProviderActivityIntervalsArchive(intervals.dependencies).write({
      sourceRevision: REVISION,
      response: {
        id: "private-provider-id",
        icuIntervals: [{ averageWatts: 271, label: "Private label" }],
        icuGroups: [{ id: "private-group" }],
      },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(intervals.snapshots[0])).toContain("271");
    expect(intervals.artifactDrafts[0]).toMatchObject({
      lane: "streams",
      externalId: `intervals:analysis:${REVISION}:${ADDRESS}`,
    });
    expect(JSON.stringify(intervals.landingDrafts[0])).not.toContain("271");
    expect(JSON.stringify(intervals.landingDrafts[0])).not.toContain("Private label");
    expect(JSON.stringify(intervals.landingDrafts[0])).not.toContain("private-provider-id");

    const efforts = setup();
    await createProviderActivityBestEffortsArchive(efforts.dependencies).write({
      sourceRevision: REVISION,
      durationSeconds: 300,
      response: {
        efforts: [{ average: 333, duration: 300, startIndex: 1, endIndex: 300, distance: 2_500 }],
      },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(efforts.snapshots[0])).toContain("333");
    expect(efforts.artifactDrafts[0]).toMatchObject({
      lane: "streams",
      externalId: `best-efforts-300:analysis:${REVISION}:${ADDRESS}`,
    });
    expect(JSON.stringify(efforts.landingDrafts[0])).not.toContain("333");
    expect(JSON.stringify(efforts.landingDrafts[0])).not.toContain("2500");
  });

  it("does not publish store evidence after cancellation", async () => {
    const controller = new AbortController();
    const state = setup({ abortAfterArchive: controller });

    await expect(
      state.archive.write({
        sourceRevision: REVISION,
        descriptors: [{ type: "time", data: [0, 1] }],
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(state.events).toEqual(["archive"]);
    expect(state.artifactDrafts).toEqual([]);
    expect(state.landingDrafts).toEqual([]);
  });

  it("rejects an invalid archive clock before any store publication", async () => {
    const state = setup();
    const archive = createProviderActivityStreamArchive({
      archive: { writeSnapshot: vi.fn() },
      store: {} as never,
      sources: {} as never,
      runExclusive: vi.fn(),
      now: () => Number.NaN,
    });

    await expect(
      archive.write({
        sourceRevision: REVISION,
        descriptors: [{ type: "time", data: [0, 1] }],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("archive clock is invalid");
    expect(state.events).toEqual([]);
  });
});
