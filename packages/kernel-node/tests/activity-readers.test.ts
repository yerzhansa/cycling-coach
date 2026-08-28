import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPAIR_FIXER_SETTINGS } from "@enduragent/kernel/ingest";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { runMigrations } from "@enduragent/kernel/store";
import {
  createManagedActivityReader,
  ManagedActivityReaderError,
  type ManagedActivityExtension,
  type ManagedActivityReaderLimits,
} from "@enduragent/kernel-node/chat-attachments";
import { createNodeImportRuntime } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const LIMITS: ManagedActivityReaderLimits = {
  activityBytes: 104_857_600,
  parserMs: 30_000,
  parserOldGenerationMiB: 256,
  sessions: 256,
};
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ingest");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixtureRoot, name)));
}

function source(bytes: Uint8Array, extension: ManagedActivityExtension) {
  return {
    objectId: "object-1",
    relativePath: `chat-attachments/${"a".repeat(64)}/object-1`,
    displayName: `ride.${extension}`,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    extension,
  } as const;
}

function reader(bytes: Uint8Array, limits = LIMITS, workerUrl?: URL) {
  return createManagedActivityReader({
    objects: { readObjectBytes: vi.fn(async () => Uint8Array.from(bytes)) },
    limits,
    ...(workerUrl === undefined ? {} : { workerUrl }),
  });
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedActivityReaderError);
    return (error as ManagedActivityReaderError).reason;
  }
  throw new Error("expected managed activity reader to reject");
}

describe("managed activity readers", () => {
  it("ships a dedicated bounded activity worker", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    expect(
      (await stat(join(packageRoot, "dist/chat-attachments/activity-reader-worker.js"))).size,
    ).toBeGreaterThan(1_000);
  });

  it.each([
    ["brick-cycling.fit", "fit"],
    ["fallback-cycling.tcx", "tcx"],
    ["fallback-cycling.gpx", "gpx"],
  ] as const)("prepares %s through the canonical decoder", async (name, extension) => {
    const bytes = await fixture(name);
    const result = await reader(bytes).read(
      source(bytes, extension),
      DEFAULT_REPAIR_FIXER_SETTINGS,
    );
    expect(result).toMatchObject({
      outcome: "prepared",
      projection: {
        kind: "parsed-activity",
        parsedActivityId: source(bytes, extension).sha256,
        sourceFormat: extension,
      },
      artifact: { ext: extension },
      prepared: { outcome: "prepared" },
    });
  });

  it("feeds only worker-prepared data into the canonical importer and replays without duplicates", async () => {
    const bytes = await fixture("brick-cycling.fit");
    const prepared = await reader(bytes).read(source(bytes, "fit"), DEFAULT_REPAIR_FIXER_SETTINGS);
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") throw new Error("fixture was quarantined");
    const root = await mkdtemp(join(tmpdir(), "activity-reader-"));
    roots.push(root);
    const store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    const runtime = createNodeImportRuntime({ archiveDir: join(root, "archive"), store });
    const importPrepared = () =>
      runtime.importBatchWithPreparation(
        { files: [prepared.artifact], platform_records: [] },
        async () => prepared.prepared,
      );
    expect((await importPrepared()).inserts.raw_file).toBe(1);
    expect((await importPrepared()).inserts.raw_file).toBe(0);
    expect(Number((await store.get("SELECT COUNT(*) AS count FROM session"))?.count)).toBe(1);
    await store.close();
  });

  it("quarantines malformed activity content and isolates timeouts and managed-byte failures", async () => {
    const malformed = new Uint8Array([12, 0, 0, 0, 0, 0, 0, 0, 46, 70, 73, 84]);
    await expect(
      reader(malformed).read(source(malformed, "fit"), DEFAULT_REPAIR_FIXER_SETTINGS),
    ).resolves.toMatchObject({ outcome: "quarantined", code: expect.stringMatching(/^fit:/u) });

    const bytes = await fixture("brick-cycling.fit");
    const stalled = new URL("data:text/javascript,setInterval(() => {}, 1000)");
    expect(
      await failure(
        reader(bytes, { ...LIMITS, parserMs: 20 }, stalled).read(
          source(bytes, "fit"),
          DEFAULT_REPAIR_FIXER_SETTINGS,
        ),
      ),
    ).toBe("parser_timeout");
    const broken = createManagedActivityReader({
      objects: {
        readObjectBytes: vi.fn(async () => {
          throw new Error("private path");
        }),
      },
      limits: LIMITS,
    });
    expect(await failure(broken.read(source(bytes, "fit"), DEFAULT_REPAIR_FIXER_SETTINGS))).toBe(
      "integrity_mismatch",
    );
  });
});
