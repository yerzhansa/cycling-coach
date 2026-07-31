import { chmod, mkdtemp, mkdir, readFile, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "@enduragent/kernel/archive";
import { createReferenceCapturePlan, validateReferenceCaptureManifest, type ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import { describe, expect, it, vi } from "vitest";
import { createArchiveManager } from "../src/archive/manager.js";
import { nodeFileSystem } from "../src/filesystem/index.js";
import { createNodeCrypto } from "../src/ingest/import-files.js";
import {
  loadReferenceCaptureSidecars,
  parseReferenceCaptureReview,
  readVerifiedReferenceSnapshot,
  writeReferenceCaptureSidecars,
} from "../src/capture-manifest/index.js";

const FIRST = "12345678-1234-4123-8123-123456789abc";
const SECOND = "22345678-1234-4123-8123-123456789abc";

function manifest(captureId = FIRST): ReferenceCaptureManifest {
  const plan = createReferenceCapturePlan(new Date("1998-07-18T12:00:00.000Z"));
  const address = "a".repeat(64), snapshot = { address, rel_path: `1998/07/${address}.json.gz` };
  return validateReferenceCaptureManifest({ schema_version: 1, capture_id: captureId, source: "external-oracle", plan,
    operation_ledger: { link_kind: "capture-id", capture_id: captureId },
    endpoints: [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile", request: { oldest: null, newest: null, activity_id: null, stream_types: [], include_defaults: null }, snapshot },
      { ordinal: 1, lane: "activities", endpoint: "activities", request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, snapshot },
      { ordinal: 2, lane: "wellness", endpoint: "wellness", request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, snapshot },
    ], records: { settings: [], activities: [], wellness: [], streams: [] },
    selected_stream_ids: [], captured_stream_ids: [], deterministic_order: { endpoint_ordinals: [0, 1, 2], settings: [], activities: [], wellness: [], streams: [] } });
}

describe("verified Reference snapshots", () => {
  it("binds the exact compressed bytes and canonical decoded JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-archive-")), crypto = createNodeCrypto();
    const archive = createArchiveManager({ archiveRoot: root, crypto, fs: nodeFileSystem() });
    const written = await archive.writeSnapshot({ b: 2, a: 1 }, { epochSeconds: 899_424_000 });
    await expect(readVerifiedReferenceSnapshot({ address: written.address, rel_path: written.relPath }, { archive, crypto }))
      .resolves.toEqual({ a: 1, b: 2 });
    const alternate = gzipSync(Buffer.from(canonicalJson({ a: 1, b: 3 })), { level: 9 });
    await expect(readVerifiedReferenceSnapshot({ address: written.address, rel_path: written.relPath }, {
      crypto, archive: { ...archive, readArtifact: async () => new Uint8Array(alternate) },
    })).rejects.toThrow(/address/);
  });
});

describe("immutable Reference capture sidecars", () => {
  it("commits canonical read-only sidecars and replays before and after rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-home-")), replay = vi.fn(async () => {});
    const result = await writeReferenceCaptureSidecars({ root, manifest: manifest(),
      review: { schema_version: 1, capture_id: FIRST, reviewed_on: "1998-07-18", replaces_capture_id: null, reason: "initial" },
      assertReplayable: replay });
    expect(result.manifest.capture_id).toBe(FIRST);
    expect(replay).toHaveBeenCalledTimes(2);
    const directory = join(root, "captures", FIRST);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "manifest.json"))).mode & 0o777).toBe(0o444);
    expect((await stat(join(directory, "review.json"))).mode & 0o777).toBe(0o444);
    await expect(writeReferenceCaptureSidecars({ root, manifest: manifest(), review: result.review,
      assertReplayable: replay })).rejects.toThrow();
    await expect(loadReferenceCaptureSidecars({ root, captureId: FIRST, assertReplayable: replay })).resolves.toEqual(result);
  });

  it("rejects noncanonical review bytes and cleans only failed pending state", async () => {
    expect(() => parseReferenceCaptureReview('{"schema_version":1}\n')).toThrow();
    const root = await mkdtemp(join(tmpdir(), "capture-home-"));
    await expect(writeReferenceCaptureSidecars({ root, manifest: manifest(),
      review: { schema_version: 1, capture_id: FIRST, reviewed_on: "1998-07-18", replaces_capture_id: null, reason: "initial" },
      assertReplayable: async () => {} }, { beforeRename: () => { throw new Error("injected"); } })).rejects.toThrow("injected");
    await expect(stat(join(root, "captures", FIRST))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "captures", `.pending-${FIRST}`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a captures symlink without writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-home-"));
    const target = await mkdtemp(join(tmpdir(), "capture-target-"));
    await symlink(target, join(root, "captures"));
    await expect(writeReferenceCaptureSidecars({ root, manifest: manifest(),
      review: { schema_version: 1, capture_id: FIRST, reviewed_on: "1998-07-18", replaces_capture_id: null, reason: "initial" },
      assertReplayable: async () => {} })).rejects.toThrow("capture sidecar mode is invalid");
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects an unsafe captures parent while loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-home-"));
    const target = await mkdtemp(join(tmpdir(), "capture-target-"));
    await symlink(target, join(root, "captures"));
    await expect(loadReferenceCaptureSidecars({ root, captureId: FIRST,
      assertReplayable: async () => {} })).rejects.toThrow("capture sidecar mode is invalid");

    const otherRoot = await mkdtemp(join(tmpdir(), "capture-home-"));
    const captures = join(otherRoot, "captures");
    await mkdir(captures, { mode: 0o700 });
    await chmod(captures, 0o755);
    await expect(loadReferenceCaptureSidecars({ root: otherRoot, captureId: FIRST,
      assertReplayable: async () => {} })).rejects.toThrow("capture sidecar mode is invalid");
  });

  it("validates and preserves the prior capture before replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "capture-home-")), replay = vi.fn(async () => {});
    await writeReferenceCaptureSidecars({ root, manifest: manifest(),
      review: { schema_version: 1, capture_id: FIRST, reviewed_on: "1998-07-18", replaces_capture_id: null, reason: "initial" }, assertReplayable: replay });
    await writeReferenceCaptureSidecars({ root, manifest: manifest(SECOND),
      review: { schema_version: 1, capture_id: SECOND, reviewed_on: "1998-07-19", replaces_capture_id: FIRST, reason: "provider-refresh" }, assertReplayable: replay });
    expect(await readFile(join(root, "captures", FIRST, "manifest.json"), "utf8")).toContain(FIRST);
  });
});
