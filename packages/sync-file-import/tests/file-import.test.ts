import { basename, dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ArchiveWriteResult } from "@enduragent/kernel/archive";
import type { FileStat } from "@enduragent/kernel/ports";
import type { SourceWatermark, SyncBudget } from "@enduragent/kernel/store";
import {
  collectReadyBatch,
  createFileImportSource,
  createFolderWatcher,
  FILE_IMPORT_POLL_INTERVAL_MS,
  type FileImportBatchEvent,
  type FileImportPorts,
} from "../src/index.js";
import { collectReadyBatch as collectFromManual } from "../src/manual.js";
import { createFolderWatcher as createFromWatcher } from "../src/watcher.js";

const ROOT = "/synthetic/inbox";
const ROOT_B = "/synthetic/second";
const MTIME = 946_684_800_000;

type FileImportBatch = Extract<FileImportBatchEvent, { readonly kind: "batch" }>;

interface FakeFile {
  bytes: Uint8Array;
  size: number;
  mtimeMs: number;
}

class FakeFileSystem {
  readonly files = new Map<string, FakeFile>();
  readonly extras = new Map<string, { name: string; kind: "file" | "directory" | "other" }[]>();
  readonly statCounts = new Map<string, number>();
  readonly readCounts = new Map<string, number>();
  readonly listCounts = new Map<string, number>();
  statHook?: (path: string, call: number) => FileStat | "missing" | "throw" | null;
  readHook?: (path: string, call: number) => Uint8Array | "throw" | null;
  listHook?: (root: string, call: number) => "throw" | null;

  put(
    path: string,
    bytes: readonly number[],
    options: { size?: number; mtimeMs?: number } = {},
  ): void {
    this.files.set(path, {
      bytes: Uint8Array.from(bytes),
      size: options.size ?? bytes.length,
      mtimeMs: options.mtimeMs ?? MTIME,
    });
  }

  async list(root: string) {
    const call = (this.listCounts.get(root) ?? 0) + 1;
    this.listCounts.set(root, call);
    if (this.listHook?.(root, call) === "throw") throw new Error("unavailable");
    const entries = [...this.files.keys()]
      .filter((path) => dirname(path) === root)
      .map((path) => ({ name: basename(path), kind: "file" as const }));
    return [...entries, ...(this.extras.get(root) ?? [])];
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const call = (this.statCounts.get(path) ?? 0) + 1;
    this.statCounts.set(path, call);
    const hooked = this.statHook?.(path, call);
    if (hooked === "throw") throw new Error("unavailable");
    if (hooked === "missing") return undefined;
    if (hooked !== null && hooked !== undefined) return hooked;
    const file = this.files.get(path);
    return file === undefined
      ? undefined
      : { kind: "file", size: file.size, mtimeMs: file.mtimeMs };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const call = (this.readCounts.get(path) ?? 0) + 1;
    this.readCounts.set(path, call);
    const hooked = this.readHook?.(path, call);
    if (hooked === "throw") throw new Error("unavailable");
    if (hooked instanceof Uint8Array) return hooked;
    const file = this.files.get(path);
    if (file === undefined) throw new Error("unavailable");
    return file.bytes;
  }
}

class TimerClock {
  readonly delays: number[] = [];
  readonly cleared: unknown[] = [];
  tick = 0;
  onTick?: (tick: number) => void;
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  constructor(readonly automatic = true) {}

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.delays.push(ms);
    this.timers.set(id, fn);
    if (this.automatic) queueMicrotask(() => this.fire(id));
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.cleared.push(handle);
    this.timers.delete(handle as number);
  };

  fire(id = this.timers.keys().next().value as number): void {
    const fn = this.timers.get(id);
    if (fn === undefined) return;
    this.timers.delete(id);
    this.tick += 1;
    this.onTick?.(this.tick);
    fn();
  }

  pending(): number {
    return this.timers.size;
  }
}

function digestBytes(bytes: Uint8Array): Uint8Array {
  let state = bytes.length;
  for (const byte of bytes) state = (state * 33 + byte) & 0xff;
  return Uint8Array.from({ length: 32 }, (_, index) => (state + index * 17) & 0xff);
}

function digestHex(bytes: Uint8Array): string {
  return Array.from(digestBytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function watermark(value: string | null = null): SourceWatermark {
  return { source: "file-import", lane: "file-discovery", value };
}

function budget(
  overrides: Partial<SyncBudget> = {},
  monotonicNow: () => number = () => 0,
): SyncBudget {
  return {
    signal: new AbortController().signal,
    clock: { monotonicNow },
    deadlineMonotonicMs: 1_000_000,
    perRequestTimeoutMs: 30_000,
    maxRequests: 10,
    maxArtifacts: 100,
    ...overrides,
  };
}

function harness(
  options: {
    clock?: TimerClock;
    fs?: FakeFileSystem;
    validate?: FileImportPorts["validate"];
    sha256?: FileImportPorts["crypto"]["sha256"];
    writeArtifact?: FileImportPorts["archive"]["writeArtifact"];
  } = {},
) {
  const fs = options.fs ?? new FakeFileSystem();
  const clock = options.clock ?? new TimerClock();
  const archiveCalls: { bytes: Uint8Array; ext: string; epochSeconds: number }[] = [];
  const validate = options.validate ?? vi.fn(async () => {});
  const sha256 = options.sha256 ?? vi.fn(async (bytes: Uint8Array) => digestBytes(bytes));
  const writeArtifact =
    options.writeArtifact ??
    vi.fn(async (bytes: Uint8Array, ext: string, when: { epochSeconds: number }) => {
      archiveCalls.push({ bytes: bytes.slice(), ext, epochSeconds: when.epochSeconds });
      const address = digestHex(bytes);
      return { address, relPath: `2000/01/${address}.${ext}`, deduped: false };
    });
  const ports: FileImportPorts = {
    fs,
    clock,
    crypto: { sha256 },
    archive: { writeArtifact },
    validate,
  };
  return { fs, clock, ports, archiveCalls, validate, sha256, writeArtifact };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function flush(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function config(manualPaths: readonly string[] = [], watchRoots: readonly string[] = []) {
  return { manualPaths, watchRoots };
}

describe("stable file import source", () => {
  it("declares the exact file-discovery capability and public subpaths", () => {
    const value = harness();
    const source = createFileImportSource(config([], [ROOT]), value.ports);
    expect(source.id).toBe("file-import");
    expect(source.capabilities).toEqual({
      activities: false,
      streams: false,
      rawFiles: true,
      wellness: false,
      plannedWorkoutPush: false,
      backfillDepth: { kind: "none" },
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.capabilities)).toBe(true);
    expect("pushPlannedWorkout" in source).toBe(false);
    expect(collectFromManual).toBe(collectReadyBatch);
    expect(createFromWatcher).toBe(createFolderWatcher);
    expect(createFolderWatcher([ROOT], value.ports).id).toBe("file-import");
  });

  it("rejects invalid configuration without exposing paths", () => {
    const value = harness();
    const invalid = [
      config(),
      config([""], []),
      config([`${ROOT}/secret.bin`], []),
      config([`${ROOT}/same.fit`, `${ROOT}/same.fit`], []),
      config([], [ROOT, ROOT]),
    ];
    for (const candidate of invalid) {
      let error: unknown;
      try {
        createFileImportSource(candidate, value.ports);
      } catch (caught) {
        error = caught;
      }
      expect(error).toEqual(new TypeError("invalid file import configuration"));
      expect(String(error)).not.toContain(ROOT);
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
    }
    expect(value.fs.statCounts.size + value.fs.listCounts.size).toBe(0);
  });

  it("rejects foreign watermark and invalid or zero budget", async () => {
    const path = `${ROOT}/one.fit`,
      value = harness();
    value.fs.put(path, [1]);
    const source = createFileImportSource(config([path]), value.ports);
    const invalidWatermarks = [
      { source: "intervals-icu", lane: "file-discovery", value: null },
      { source: "file-import", lane: "activities", value: null },
      { source: "file-import", lane: "file-discovery", value: "sha256:ABC" },
    ] as SourceWatermark[];
    for (const input of invalidWatermarks) {
      await expect(
        source.pullBatches(input, budget())[Symbol.asyncIterator]().next(),
      ).rejects.toEqual(new TypeError("invalid file import watermark"));
    }
    for (const overrides of [
      { maxArtifacts: 0 },
      { maxRequests: 0 },
      { perRequestTimeoutMs: 0 },
      { deadlineMonotonicMs: Number.NaN },
    ]) {
      await expect(
        source.pullBatches(watermark(), budget(overrides))[Symbol.asyncIterator]().next(),
      ).rejects.toEqual(new TypeError("invalid file import budget"));
    }
    expect(value.fs.statCounts.size).toBe(0);
  });

  it("manual FIT TCX and GPX wait two intervals and return one batch plus checkpoint", async () => {
    const value = harness();
    const paths = [`${ROOT}/a.FIT`, `${ROOT}/b.tcx`, `${ROOT}/c.GpX`];
    paths.forEach((path, index) => value.fs.put(path, [index + 1]));
    const result = await collectReadyBatch(
      { paths, watermark: watermark(), budget: budget() },
      value.ports,
    );
    expect(value.clock.delays).toEqual([250, 250]);
    expect(result?.artifacts.map((artifact) => artifact.file.ext)).toEqual(["fit", "tcx", "gpx"]);
    expect(result?.artifacts.map((artifact) => artifact.file.input_path)).toEqual(paths);
    expect(result?.checkpoint.kind).toBe("checkpoint");
    expect(result?.checkpoint.watermark.value).toBe(`sha256:${digestHex(Uint8Array.of(3))}`);
    expect(value.archiveCalls).toHaveLength(3);
  });

  it("manual-only duplicate suppression returns a terminal no-op checkpoint", async () => {
    const path = `${ROOT}/same.fit`,
      value = harness();
    value.fs.put(path, [7, 7]);
    const prior = `sha256:${digestHex(Uint8Array.of(7, 7))}`;
    const result = await collectReadyBatch(
      { paths: [path], watermark: watermark(prior), budget: budget() },
      value.ports,
    );
    expect(result).toEqual({
      artifacts: [],
      checkpoint: { kind: "checkpoint", watermark: watermark(prior) },
    });
    expect(value.archiveCalls).toHaveLength(0);
  });

  it("polling uses 250 ms and abort clears the timer without a checkpoint", async () => {
    const clock = new TimerClock(false),
      value = harness({ clock });
    const path = `${ROOT}/paused.fit`;
    value.fs.put(path, [1]);
    const controller = new AbortController();
    const iterator = createFileImportSource(config([path]), value.ports)
      .pullBatches(watermark(), budget({ signal: controller.signal }))
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await flush();
    expect(clock.delays).toEqual([FILE_IMPORT_POLL_INTERVAL_MS]);
    expect(clock.pending()).toBe(1);
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(clock.cleared).toHaveLength(1);
    expect(value.archiveCalls).toHaveLength(0);

    const helperClock = new TimerClock(false),
      helper = harness({ clock: helperClock });
    helper.fs.put(path, [1]);
    const helperController = new AbortController();
    const helperPending = collectReadyBatch(
      {
        paths: [path],
        watermark: watermark(),
        budget: budget({ signal: helperController.signal }),
      },
      helper.ports,
    );
    await flush();
    helperController.abort();
    await expect(helperPending).resolves.toBeNull();
    await expect(
      collectReadyBatch(
        { paths: [path], watermark: watermark(), budget: budget({ deadlineMonotonicMs: 0 }) },
        helper.ports,
      ),
    ).resolves.toBeNull();
  });

  it("paused content remains blocked until structural validation succeeds", async () => {
    let attempts = 0;
    const value = harness({
      validate: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("paused");
      }),
    });
    const path = `${ROOT}/paused.fit`;
    value.fs.put(path, [1, 2]);
    const events = await collect(
      createFileImportSource(config([path]), value.ports).pullBatches(watermark(), budget()),
    );
    expect(events.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
    expect(attempts).toBe(2);
    expect(value.clock.delays).toHaveLength(5);
    expect(value.archiveCalls).toHaveLength(1);
  });

  it("pre-read post-read and final identity changes discard the entire proposal", async () => {
    for (const faultCall of [4, 5, 7]) {
      const value = harness(),
        path = `${ROOT}/moving.fit`;
      value.fs.put(path, [4]);
      let faulted = false;
      value.fs.statHook = (candidate, call) => {
        if (candidate === path && call === faultCall && !faulted) {
          faulted = true;
          return { kind: "file", size: 5, mtimeMs: MTIME };
        }
        return null;
      };
      const events = await collect(
        createFileImportSource(config([path]), value.ports).pullBatches(watermark(), budget()),
      );
      expect(events.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
      expect(faulted).toBe(true);
      expect(value.clock.delays.length).toBeGreaterThanOrEqual(4);
      expect(value.archiveCalls.length).toBe(faultCall === 7 ? 2 : 1);
    }
  });

  it("read stat missing-root and sleep wake pauses reset globally and recover", async () => {
    for (const unavailable of ["read", "stat"] as const) {
      const value = harness(),
        path = `${ROOT}/${unavailable}.fit`;
      value.fs.put(path, [2]);
      if (unavailable === "read")
        value.fs.readHook = (_path, call) => (call === 1 ? "throw" : null);
      else value.fs.statHook = (_path, call) => (call === 4 ? "missing" : null);
      const events = await collect(
        createFileImportSource(config([path]), value.ports).pullBatches(watermark(), budget()),
      );
      expect(events.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
      expect(value.clock.delays.length).toBeGreaterThanOrEqual(4);
    }
    const value = harness();
    value.fs.put(`${ROOT}/b.fit`, [2]);
    value.fs.put(`${ROOT}/a.fit`, [1]);
    value.clock.onTick = (tick) => {
      value.fs.listHook = () => (tick === 1 ? "throw" : null);
    };
    const events = await collect(
      createFolderWatcher([ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    expect(value.clock.delays).toHaveLength(4);
    expect(events[0]).toMatchObject({
      kind: "batch",
      artifacts: [
        { file: { input_path: `${ROOT}/a.fit` } },
        { file: { input_path: `${ROOT}/b.fit` } },
      ],
    });
    expect(events.at(-1)?.kind).toBe("checkpoint");
  });

  it("atomic temp rename ignores the temporary name and admits the final name", async () => {
    const value = harness();
    value.fs.extras.set(ROOT, [{ name: "incoming.fit.part", kind: "file" }]);
    value.clock.onTick = (tick) => {
      if (tick === 1) {
        value.fs.extras.set(ROOT, []);
        value.fs.put(`${ROOT}/final.fit`, [9]);
      }
    };
    const events = await collect(
      createFolderWatcher([ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    expect(value.clock.delays).toHaveLength(3);
    expect(
      (events[0] as FileImportBatch).artifacts[0]?.file.input_path,
    ).toBe(`${ROOT}/final.fit`);
  });

  it("mixed valid and invalid watch files stay in one atomic proposal", async () => {
    let rejected = false;
    const value = harness({
      validate: vi.fn(async ({ bytes }) => {
        if (bytes[0] === 0 && !rejected) {
          rejected = true;
          throw new Error("paused");
        }
      }),
    });
    value.fs.put(`${ROOT}/a.fit`, [1]);
    value.fs.put(`${ROOT}/b.fit`, [0]);
    const events = await collect(
      createFolderWatcher([ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    expect(rejected).toBe(true);
    expect(value.archiveCalls).toHaveLength(2);
    expect((events[0] as FileImportBatch).artifacts).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
  });

  it("twenty arriving files produce one quiescent batch", async () => {
    const value = harness();
    value.clock.onTick = (tick) => {
      if (tick <= 20) value.fs.put(`${ROOT}/f${String(tick).padStart(2, "0")}.fit`, [tick]);
    };
    const events = await collect(
      createFolderWatcher([ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    expect(value.clock.delays).toHaveLength(22);
    expect(events.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
    expect((events[0] as FileImportBatch).artifacts).toHaveLength(20);
    expect(value.archiveCalls).toHaveLength(20);
  });

  it("sixty arriving files produce one quiescent batch", async () => {
    const value = harness();
    value.clock.onTick = (tick) => {
      if (tick <= 60) value.fs.put(`${ROOT}/f${String(tick).padStart(2, "0")}.gpx`, [tick]);
    };
    const events = await collect(
      createFolderWatcher([ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    expect(value.clock.delays).toHaveLength(62);
    expect((events[0] as FileImportBatch).artifacts).toHaveLength(60);
    expect(value.archiveCalls).toHaveLength(60);
  });

  it("two roots share one globally sorted quiescent batch", async () => {
    const value = harness();
    value.fs.put(`${ROOT_B}/a.fit`, [3]);
    value.fs.put(`${ROOT}/z.tcx`, [4]);
    value.fs.put(`${ROOT}/a.gpx`, [5]);
    const events = await collect(
      createFolderWatcher([ROOT_B, ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    const paths = (events[0] as FileImportBatch).artifacts.map((item) => item.file.input_path);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(paths).toHaveLength(3);
    expect(value.fs.listCounts.get(ROOT)).toBe(value.fs.listCounts.get(ROOT_B));
  });

  it("duplicate content inside one batch uses a provisional last digest", async () => {
    const value = harness();
    value.fs.put(`${ROOT}/a.fit`, [8]);
    value.fs.put(`${ROOT}/b.fit`, [8]);
    const events = await collect(
      createFolderWatcher([ROOT], value.ports).pullBatches(watermark(), budget()),
    );
    const batch = events[0] as FileImportBatch;
    expect(batch.artifacts.map((artifact) => artifact.file.input_path)).toEqual([`${ROOT}/a.fit`]);
    expect(value.archiveCalls).toHaveLength(1);
    expect((events[1] as { watermark: { value: string } }).watermark.value).toBe(
      `sha256:${digestHex(Uint8Array.of(8))}`,
    );
  });

  it("unchanged delivered metadata is revalidated every eight stable polls", async () => {
    const value = harness();
    value.fs.put(`${ROOT}/one.fit`, [1]);
    value.fs.put(`${ROOT}/two.fit`, [2]);
    const source = createFolderWatcher([ROOT], value.ports);
    await collect(source.pullBatches(watermark(), budget()));
    const hashesBefore = vi.mocked(value.sha256).mock.calls.length;
    value.clock.delays.length = 0;
    const events = await collect(
      source.pullBatches(watermark(`sha256:${digestHex(Uint8Array.of(2))}`), budget()),
    );
    expect(value.clock.delays).toHaveLength(8);
    expect(vi.mocked(value.sha256).mock.calls.length).toBe(hashesBefore + 2);
    expect(events).toEqual([
      { kind: "checkpoint", watermark: watermark(`sha256:${digestHex(Uint8Array.of(2))}`) },
    ]);
    expect(value.archiveCalls).toHaveLength(2);
  });

  it("same-size same-mtime content after delivery is eventually emitted", async () => {
    const value = harness();
    value.fs.put(`${ROOT}/one.fit`, [1]);
    const source = createFolderWatcher([ROOT], value.ports);
    const first = await collect(source.pullBatches(watermark(), budget()));
    const firstMark = (first.at(-1) as { watermark: SourceWatermark }).watermark.value;
    value.fs.put(`${ROOT}/one.fit`, [2], { size: 1, mtimeMs: MTIME });
    value.clock.delays.length = 0;
    const second = await collect(source.pullBatches(watermark(firstMark), budget()));
    expect(value.clock.delays).toHaveLength(8);
    expect(second.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
    expect(
      (second[0] as FileImportBatch).artifacts[0]?.file.bytes,
    ).toEqual(Uint8Array.of(2));
    expect(value.archiveCalls).toHaveLength(2);
  });

  it("archive completes before artifact yield and checkpoint is terminal", async () => {
    let resolveArchive!: (value: ArchiveWriteResult) => void;
    const path = `${ROOT}/ordered.fit`,
      bytes = Uint8Array.of(6);
    const clock = new TimerClock(false);
    const value = harness({
      clock,
      writeArtifact: vi.fn<FileImportPorts["archive"]["writeArtifact"]>(
        () =>
          new Promise<ArchiveWriteResult>((resolve) => {
            resolveArchive = resolve;
          }),
      ),
    });
    value.fs.put(path, [...bytes]);
    const source = createFileImportSource(config([path]), value.ports);
    const iterator = source.pullBatches(watermark(), budget())[Symbol.asyncIterator]();
    const first = iterator.next();
    await flush();
    clock.fire();
    await flush();
    clock.fire();
    await flush();
    let yielded = false;
    void first.then(() => {
      yielded = true;
    });
    await flush();
    expect(yielded).toBe(false);
    resolveArchive({ address: digestHex(bytes), relPath: "2000/01/archive.fit", deduped: false });
    expect((await first).value).toMatchObject({ kind: "batch" });
    expect((await iterator.next()).value).toMatchObject({ kind: "checkpoint" });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    const rollback = harness();
    rollback.fs.put(`${ROOT}/rollback.fit`, [3]);
    const uncommitted = createFolderWatcher([ROOT], rollback.ports);
    const abandoned = uncommitted.pullBatches(watermark(), budget())[Symbol.asyncIterator]();
    expect((await abandoned.next()).value).toMatchObject({ kind: "batch" });
    await abandoned.return?.();
    rollback.clock.delays.length = 0;
    const retried = await collect(uncommitted.pullBatches(watermark(), budget()));
    expect(rollback.clock.delays).toHaveLength(2);
    expect(retried.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);

    const expired = harness();
    expired.fs.put(`${ROOT}/expired.fit`, [4]);
    const tentative = createFolderWatcher([ROOT], expired.ports);
    let now = 0;
    const expiring = tentative
      .pullBatches(watermark(), budget({}, () => now))
      [Symbol.asyncIterator]();
    expect((await expiring.next()).value).toMatchObject({ kind: "batch" });
    expect((await expiring.next()).value).toMatchObject({ kind: "checkpoint" });
    now = 1_000_000;
    await expect(expiring.next()).resolves.toEqual({ done: true, value: undefined });
    expired.clock.delays.length = 0;
    const afterExpiry = await collect(tentative.pullBatches(watermark(), budget()));
    expect(expired.clock.delays).toHaveLength(2);
    expect(afterExpiry.map((event) => event.kind)).toEqual(["batch", "checkpoint"]);
  });

  it("archive failure and public errors are path-free and carry no cause", async () => {
    const suppliedPath = `${ROOT}/private.fit`;
    const errors: unknown[] = [];
    for (const writeArtifact of [
      vi.fn(async () => {
        throw new Error(suppliedPath);
      }),
      vi.fn(async () => ({ address: "bad", relPath: suppliedPath, deduped: false })),
    ]) {
      const value = harness({ writeArtifact });
      value.fs.put(suppliedPath, [1]);
      try {
        await collect(
          createFileImportSource(config([suppliedPath]), value.ports).pullBatches(
            watermark(),
            budget(),
          ),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    const shortDigest = harness({ sha256: vi.fn(async () => Uint8Array.of(1)) });
    shortDigest.fs.put(suppliedPath, [1]);
    try {
      await collect(
        createFileImportSource(config([suppliedPath]), shortDigest.ports).pullBatches(
          watermark(),
          budget(),
        ),
      );
    } catch (error) {
      errors.push(error);
    }
    expect(errors.map((error) => (error as Error).message)).toEqual([
      "file archive failed",
      "file archive result mismatch",
      "invalid SHA-256 digest",
    ]);
    for (const error of errors) {
      const own: unknown[] = [];
      const visit = (value: unknown): void => {
        if (value === null || (typeof value !== "object" && typeof value !== "function")) {
          own.push(value);
          return;
        }
        for (const key of Object.getOwnPropertyNames(value)) {
          own.push(key);
          visit((value as Record<string, unknown>)[key]);
        }
      };
      visit(error);
      expect(
        [String(error), (error as Error).message, JSON.stringify(error), JSON.stringify(own)].join(
          " ",
        ),
      ).not.toContain(suppliedPath);
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
    }
  });

  it("remaining artifact budget never splits a burst or emits a checkpoint", async () => {
    const first = harness();
    first.fs.put(`${ROOT}/a.fit`, [1]);
    first.fs.put(`${ROOT}/b.fit`, [2]);
    const oversized = createFolderWatcher([ROOT], first.ports).pullBatches(
      watermark(),
      budget({ maxArtifacts: 1 }),
    );
    await expect(collect(oversized)).rejects.toEqual(
      new RangeError("file import burst exceeds artifact budget"),
    );
    expect(first.archiveCalls).toHaveLength(0);

    const exact = harness();
    exact.fs.put(`${ROOT}/a.fit`, [1]);
    exact.fs.put(`${ROOT}/b.fit`, [2]);
    expect(
      (
        await collect(
          createFolderWatcher([ROOT], exact.ports).pullBatches(
            watermark(),
            budget({ maxArtifacts: 2 }),
          ),
        )
      ).map((event) => event.kind),
    ).toEqual(["batch", "checkpoint"]);

    const mixed = harness();
    mixed.fs.put(`${ROOT}/manual.fit`, [1]);
    mixed.fs.put(`${ROOT_B}/a.fit`, [2]);
    mixed.fs.put(`${ROOT_B}/b.fit`, [3]);
    const iterator = createFileImportSource(config([`${ROOT}/manual.fit`], [ROOT_B]), mixed.ports)
      .pullBatches(watermark(), budget({ maxArtifacts: 2 }))
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      kind: "batch",
      artifacts: [{ file: { input_path: `${ROOT}/manual.fit` } }],
    });
    await expect(iterator.next()).rejects.toEqual(
      new RangeError("file import burst exceeds artifact budget"),
    );
    expect(mixed.archiveCalls).toHaveLength(1);
  });

  it("generic pull flattens batches and ends with the exact checkpoint", async () => {
    const value = harness();
    value.fs.put(`${ROOT}/a.fit`, [1]);
    value.fs.put(`${ROOT}/b.gpx`, [2]);
    const source = createFileImportSource(config([`${ROOT}/a.fit`, `${ROOT}/b.gpx`]), value.ports);
    const events = await collect(source.pull(watermark(), budget()));
    expect(events.map((event) => event.kind)).toEqual(["raw-file", "raw-file", "checkpoint"]);
    expect(events.at(-1)).toEqual({
      kind: "checkpoint",
      watermark: watermark(`sha256:${digestHex(Uint8Array.of(2))}`),
    });
    expect(Object.isFrozen(events.at(-1))).toBe(true);
  });
});
