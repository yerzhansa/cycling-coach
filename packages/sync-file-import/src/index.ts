import { extname, join } from "node:path";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { Clock } from "@enduragent/kernel/concurrency";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import type {
  SourceArtifact,
  SourceCheckpoint,
  SourceWatermark,
  SyncBudget,
  SyncSource,
} from "@enduragent/kernel/store";

export const FILE_IMPORT_POLL_INTERVAL_MS = 250 as const;
export const FILE_IMPORT_IDENTITY_STABILITY_MS = 500 as const;
export const FILE_IMPORT_QUIESCE_MS = 500 as const;
export const FILE_IMPORT_REVALIDATION_POLLS = 8 as const;

export type FileImportExtension = "fit" | "tcx" | "gpx";
export type RawFileSourceArtifact = Extract<SourceArtifact, { readonly kind: "raw-file" }>;

export interface FileStructuralValidationInput {
  readonly bytes: Uint8Array;
  readonly ext: FileImportExtension;
}

export type FileStructuralValidator = (input: FileStructuralValidationInput) => Promise<void>;

export interface FileImportPorts {
  readonly fs: Pick<FileSystemPort, "list" | "stat" | "readFile">;
  readonly clock: Pick<Clock, "setTimeout" | "clearTimeout">;
  readonly crypto: Pick<CryptoPort, "sha256">;
  readonly archive: Pick<ArchiveManager, "writeArtifact">;
  readonly validate: FileStructuralValidator;
}

export interface FileImportSourceConfig {
  readonly manualPaths: readonly string[];
  readonly watchRoots: readonly string[];
}

export type FileImportBatchEvent =
  | { readonly kind: "batch"; readonly artifacts: readonly RawFileSourceArtifact[] }
  | SourceCheckpoint;

export interface FileImportSource extends SyncSource {
  readonly id: "file-import";
  pullBatches(watermark: SourceWatermark, budget: SyncBudget): AsyncIterable<FileImportBatchEvent>;
}

export interface CollectReadyBatchOptions {
  readonly paths: readonly string[];
  readonly watermark: SourceWatermark;
  readonly budget: SyncBudget;
}

export interface CollectedReadyBatch {
  readonly artifacts: readonly RawFileSourceArtifact[];
  readonly checkpoint: SourceCheckpoint;
}

interface FileIdentity {
  readonly kind: "file";
  readonly size: number;
  readonly mtimeMs: number;
}

interface Candidate {
  readonly path: string;
  readonly ext: FileImportExtension;
  readonly identity: FileIdentity;
}

interface StagedCandidate extends Candidate {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly archiveInstant: { readonly epochSeconds: number };
}

interface DeliveredMarker {
  readonly identity: FileIdentity;
  readonly digest: string;
  readonly unchangedPollsSinceValidation: number;
}

interface ProposalSuccess {
  readonly kind: "success";
  readonly artifacts: readonly RawFileSourceArtifact[];
  readonly lastDigest: string | null;
  readonly staged: readonly StagedCandidate[];
}

type ProposalResult = ProposalSuccess | { readonly kind: "retry" } | { readonly kind: "inactive" };
type ScanResult =
  | { readonly kind: "ready"; readonly candidates: readonly Candidate[] }
  | { readonly kind: "unavailable" }
  | { readonly kind: "inactive" };

const STABLE_POLLS_REQUIRED = FILE_IMPORT_IDENTITY_STABILITY_MS / FILE_IMPORT_POLL_INTERVAL_MS;
const QUIESCENT_POLLS_REQUIRED = FILE_IMPORT_QUIESCE_MS / FILE_IMPORT_POLL_INTERVAL_MS;

if (
  !Number.isSafeInteger(STABLE_POLLS_REQUIRED) ||
  STABLE_POLLS_REQUIRED <= 0 ||
  !Number.isSafeInteger(QUIESCENT_POLLS_REQUIRED) ||
  QUIESCENT_POLLS_REQUIRED <= 0 ||
  !Number.isSafeInteger(FILE_IMPORT_REVALIDATION_POLLS) ||
  FILE_IMPORT_REVALIDATION_POLLS <= 0
) {
  throw new Error("file import timing invariant");
}

const EXTENSIONS = new Set<FileImportExtension>(["fit", "tcx", "gpx"]);
const CAPABILITIES = Object.freeze({
  activities: false,
  streams: false,
  rawFiles: true,
  wellness: false,
  plannedWorkoutPush: false,
  backfillDepth: Object.freeze({ kind: "none" as const }),
});

function extension(path: string): FileImportExtension | null {
  const value = extname(path).slice(1).toLowerCase();
  return EXTENSIONS.has(value as FileImportExtension) ? (value as FileImportExtension) : null;
}

function validIdentity(value: unknown): value is FileIdentity {
  if (value === null || typeof value !== "object") return false;
  const stat = value as { kind?: unknown; size?: unknown; mtimeMs?: unknown };
  return (
    stat.kind === "file" &&
    typeof stat.size === "number" &&
    Number.isSafeInteger(stat.size) &&
    stat.size >= 0 &&
    typeof stat.mtimeMs === "number" &&
    Number.isFinite(stat.mtimeMs) &&
    stat.mtimeMs >= 0
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameVector(left: readonly Candidate[], right: readonly Candidate[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (candidate, index) =>
        candidate.path === right[index]?.path &&
        sameIdentity(candidate.identity, right[index].identity),
    )
  );
}

function active(budget: SyncBudget): boolean {
  return !budget.signal.aborted && budget.clock.monotonicNow() < budget.deadlineMonotonicMs;
}

function validateConfiguration(config: FileImportSourceConfig): void {
  const manualPaths = config?.manualPaths;
  const watchRoots = config?.watchRoots;
  const validArray = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
  if (
    !validArray(manualPaths) ||
    !validArray(watchRoots) ||
    new Set(manualPaths).size !== manualPaths.length ||
    new Set(watchRoots).size !== watchRoots.length ||
    manualPaths.length + watchRoots.length === 0 ||
    manualPaths.some((path) => extension(path) === null)
  ) {
    throw new TypeError("invalid file import configuration");
  }
}

function validatePull(watermark: SourceWatermark, budget: SyncBudget): void {
  if (
    watermark?.source !== "file-import" ||
    watermark.lane !== "file-discovery" ||
    !(watermark.value === null || /^sha256:[0-9a-f]{64}$/.test(watermark.value))
  ) {
    throw new TypeError("invalid file import watermark");
  }
  const positiveSafeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (
    !(budget?.signal instanceof AbortSignal) ||
    typeof budget.clock?.monotonicNow !== "function" ||
    !Number.isFinite(budget.deadlineMonotonicMs) ||
    budget.deadlineMonotonicMs < 0 ||
    !positiveSafeInteger(budget.perRequestTimeoutMs) ||
    !positiveSafeInteger(budget.maxRequests) ||
    !positiveSafeInteger(budget.maxArtifacts)
  ) {
    throw new TypeError("invalid file import budget");
  }
}

async function waitForPoll(ports: FileImportPorts, budget: SyncBudget): Promise<boolean> {
  if (!active(budget)) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let handle: unknown;
    const finish = (result: boolean, clear: boolean): void => {
      if (settled) return;
      settled = true;
      budget.signal.removeEventListener("abort", onAbort);
      if (clear) ports.clock.clearTimeout(handle);
      resolve(result);
    };
    const onAbort = (): void => finish(false, true);
    handle = ports.clock.setTimeout(() => finish(true, false), FILE_IMPORT_POLL_INTERVAL_MS);
    budget.signal.addEventListener("abort", onAbort, { once: true });
    if (budget.signal.aborted) onAbort();
  });
}

async function scanManual(
  paths: readonly string[],
  ports: FileImportPorts,
  budget: SyncBudget,
): Promise<ScanResult> {
  const candidates: Candidate[] = [];
  for (const path of paths) {
    if (!active(budget)) return { kind: "inactive" };
    let stat: Awaited<ReturnType<FileImportPorts["fs"]["stat"]>>;
    try {
      stat = await ports.fs.stat(path);
    } catch {
      return { kind: "unavailable" };
    }
    if (!validIdentity(stat)) return { kind: "unavailable" };
    candidates.push({ path, ext: extension(path)!, identity: stat });
  }
  return { kind: "ready", candidates };
}

async function scanWatch(
  roots: readonly string[],
  ports: FileImportPorts,
  budget: SyncBudget,
): Promise<ScanResult> {
  const paths = new Map<string, FileImportExtension>();
  let unavailable = false;
  for (const root of roots) {
    if (!active(budget)) return { kind: "inactive" };
    try {
      const entries = await ports.fs.list(root);
      for (const entry of entries) {
        const ext = entry.kind === "file" ? extension(entry.name) : null;
        if (ext !== null) paths.set(join(root, entry.name), ext);
      }
    } catch {
      unavailable = true;
    }
  }
  if (unavailable) return { kind: "unavailable" };
  const candidates: Candidate[] = [];
  const sortedPaths = [...paths.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const path of sortedPaths) {
    if (!active(budget)) return { kind: "inactive" };
    let stat: Awaited<ReturnType<FileImportPorts["fs"]["stat"]>>;
    try {
      stat = await ports.fs.stat(path);
    } catch {
      return { kind: "unavailable" };
    }
    if (!validIdentity(stat)) return { kind: "unavailable" };
    candidates.push({ path, ext: paths.get(path)!, identity: stat });
  }
  return { kind: "ready", candidates };
}

function hexDigest(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error("invalid SHA-256 digest");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function processProposal(
  candidates: readonly Candidate[],
  expectedVector: readonly Candidate[],
  scanVector: () => Promise<ScanResult>,
  lastDigest: string | null,
  deliveredMarkers: ReadonlyMap<string, DeliveredMarker> | null,
  artifactsYielded: number,
  ports: FileImportPorts,
  budget: SyncBudget,
): Promise<ProposalResult> {
  const staged: StagedCandidate[] = [];
  for (const candidate of candidates) {
    if (!active(budget)) return { kind: "inactive" };
    let pre: Awaited<ReturnType<FileImportPorts["fs"]["stat"]>>;
    try {
      pre = await ports.fs.stat(candidate.path);
    } catch {
      return { kind: "retry" };
    }
    if (!validIdentity(pre) || !sameIdentity(pre, candidate.identity)) return { kind: "retry" };
    if (!active(budget)) return { kind: "inactive" };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await ports.fs.readFile(candidate.path));
    } catch {
      return { kind: "retry" };
    }
    if (!active(budget)) return { kind: "inactive" };
    let post: Awaited<ReturnType<FileImportPorts["fs"]["stat"]>>;
    try {
      post = await ports.fs.stat(candidate.path);
    } catch {
      return { kind: "retry" };
    }
    if (
      !validIdentity(post) ||
      !sameIdentity(post, pre) ||
      !sameIdentity(post, candidate.identity)
    ) {
      return { kind: "retry" };
    }
    if (!active(budget)) return { kind: "inactive" };
    try {
      await ports.validate({ bytes: bytes.slice(), ext: candidate.ext });
    } catch {
      return { kind: "retry" };
    }
    if (!active(budget)) return { kind: "inactive" };
    const digest = hexDigest(await ports.crypto.sha256(bytes));
    staged.push({
      ...candidate,
      bytes,
      digest,
      archiveInstant: Object.freeze({ epochSeconds: Math.floor(post.mtimeMs / 1000) }),
    });
  }

  if (!active(budget)) return { kind: "inactive" };
  const beforeArchive = await scanVector();
  if (beforeArchive.kind === "inactive") return beforeArchive;
  if (
    beforeArchive.kind === "unavailable" ||
    !sameVector(beforeArchive.candidates, expectedVector)
  ) {
    return { kind: "retry" };
  }

  let provisionalLastDigest = lastDigest;
  const kept: StagedCandidate[] = [];
  for (const candidate of staged) {
    if (
      candidate.digest !== provisionalLastDigest &&
      candidate.digest !== deliveredMarkers?.get(candidate.path)?.digest
    ) {
      kept.push(candidate);
    }
    provisionalLastDigest = candidate.digest;
  }
  if (kept.length > budget.maxArtifacts - artifactsYielded) {
    throw new RangeError("file import burst exceeds artifact budget");
  }

  const artifacts: RawFileSourceArtifact[] = [];
  for (const candidate of kept) {
    if (!active(budget)) return { kind: "inactive" };
    let archive: Awaited<ReturnType<FileImportPorts["archive"]["writeArtifact"]>>;
    try {
      archive = await ports.archive.writeArtifact(
        candidate.bytes,
        candidate.ext,
        candidate.archiveInstant,
      );
    } catch {
      if (!active(budget)) return { kind: "inactive" };
      throw new Error("file archive failed");
    }
    if (
      archive.address !== candidate.digest ||
      typeof archive.relPath !== "string" ||
      archive.relPath.length === 0 ||
      typeof archive.deduped !== "boolean"
    ) {
      throw new Error("file archive result mismatch");
    }
    Object.freeze(archive);
    const file = Object.freeze({
      input_path: candidate.path,
      bytes: candidate.bytes.slice(),
      ext: candidate.ext,
    });
    artifacts.push(
      Object.freeze({
        kind: "raw-file" as const,
        source: "file-import" as const,
        lane: "file-discovery" as const,
        externalId: null,
        archiveInstant: candidate.archiveInstant,
        archive,
        file,
      }),
    );
  }

  if (!active(budget)) return { kind: "inactive" };
  const afterArchive = await scanVector();
  if (afterArchive.kind === "inactive") return afterArchive;
  if (afterArchive.kind === "unavailable" || !sameVector(afterArchive.candidates, expectedVector)) {
    return { kind: "retry" };
  }
  return {
    kind: "success",
    artifacts: Object.freeze(artifacts),
    lastDigest: provisionalLastDigest,
    staged: Object.freeze(staged),
  };
}

function checkpoint(lastDigest: string | null, input: SourceWatermark): SourceCheckpoint {
  return Object.freeze({
    kind: "checkpoint" as const,
    watermark: Object.freeze({
      source: "file-import" as const,
      lane: "file-discovery" as const,
      value: lastDigest === null ? input.value : `sha256:${lastDigest}`,
    }),
  });
}

function cloneMarkers(markers: ReadonlyMap<string, DeliveredMarker>): Map<string, DeliveredMarker> {
  return new Map(
    [...markers].map(([path, marker]) => [path, { ...marker, identity: { ...marker.identity } }]),
  );
}

export function createFileImportSource(
  config: FileImportSourceConfig,
  ports: FileImportPorts,
): FileImportSource {
  validateConfiguration(config);
  const manualPaths = [...config.manualPaths];
  const watchRoots = [...config.watchRoots];
  let committedMarkers = new Map<string, DeliveredMarker>();

  async function* pullBatches(
    watermark: SourceWatermark,
    budget: SyncBudget,
  ): AsyncGenerator<FileImportBatchEvent> {
    validatePull(watermark, budget);
    if (!active(budget)) return;
    let tentativeLastDigest =
      watermark.value === null ? null : watermark.value.slice("sha256:".length);
    const tentativeMarkers = cloneMarkers(committedMarkers);
    let artifactsYielded = 0;

    if (manualPaths.length > 0) {
      let observed: readonly Candidate[] | null = null;
      let unchangedPolls = 0;
      while (true) {
        const scan = await scanManual(manualPaths, ports, budget);
        if (scan.kind === "inactive") return;
        if (scan.kind === "unavailable") {
          observed = null;
          unchangedPolls = 0;
        } else if (observed !== null && sameVector(observed, scan.candidates)) {
          unchangedPolls += 1;
          if (unchangedPolls >= STABLE_POLLS_REQUIRED) {
            const proposal = await processProposal(
              scan.candidates,
              scan.candidates,
              () => scanManual(manualPaths, ports, budget),
              tentativeLastDigest,
              null,
              artifactsYielded,
              ports,
              budget,
            );
            if (proposal.kind === "inactive") return;
            if (proposal.kind === "retry") {
              observed = null;
              unchangedPolls = 0;
            } else {
              if (proposal.artifacts.length > 0) {
                if (!active(budget)) return;
                yield Object.freeze({ kind: "batch" as const, artifacts: proposal.artifacts });
                if (!active(budget)) return;
                artifactsYielded += proposal.artifacts.length;
              }
              tentativeLastDigest = proposal.lastDigest;
              break;
            }
          }
        } else {
          observed = scan.candidates;
          unchangedPolls = 0;
        }
        if (!(await waitForPoll(ports, budget))) return;
      }
    }

    if (watchRoots.length > 0) {
      let observed: readonly Candidate[] | null = null;
      let unchangedPolls = 0;
      while (true) {
        const scan = await scanWatch(watchRoots, ports, budget);
        if (scan.kind === "inactive") return;
        if (scan.kind === "unavailable") {
          observed = null;
          unchangedPolls = 0;
          for (const [path, marker] of tentativeMarkers) {
            tentativeMarkers.set(path, { ...marker, unchangedPollsSinceValidation: 0 });
          }
        } else {
          const present = new Set(scan.candidates.map((candidate) => candidate.path));
          for (const path of tentativeMarkers.keys()) {
            if (!present.has(path)) tentativeMarkers.delete(path);
          }
          for (const candidate of scan.candidates) {
            const marker = tentativeMarkers.get(candidate.path);
            if (marker === undefined) continue;
            if (!sameIdentity(marker.identity, candidate.identity)) {
              tentativeMarkers.delete(candidate.path);
            } else {
              const previous = observed?.find((item) => item.path === candidate.path);
              tentativeMarkers.set(candidate.path, {
                ...marker,
                unchangedPollsSinceValidation:
                  previous !== undefined && sameIdentity(previous.identity, candidate.identity)
                    ? marker.unchangedPollsSinceValidation + 1
                    : marker.unchangedPollsSinceValidation,
              });
            }
          }

          if (observed !== null && sameVector(observed, scan.candidates)) {
            unchangedPolls += 1;
          } else {
            observed = scan.candidates;
            unchangedPolls = 0;
          }

          if (unchangedPolls >= Math.max(STABLE_POLLS_REQUIRED, QUIESCENT_POLLS_REQUIRED)) {
            const candidates = scan.candidates.filter((candidate) => {
              const marker = tentativeMarkers.get(candidate.path);
              return (
                marker === undefined ||
                marker.unchangedPollsSinceValidation >= FILE_IMPORT_REVALIDATION_POLLS
              );
            });
            if (candidates.length > 0 || scan.candidates.length === 0) {
              const proposal = await processProposal(
                candidates,
                scan.candidates,
                () => scanWatch(watchRoots, ports, budget),
                tentativeLastDigest,
                tentativeMarkers,
                artifactsYielded,
                ports,
                budget,
              );
              if (proposal.kind === "inactive") return;
              if (proposal.kind === "retry") {
                observed = null;
                unchangedPolls = 0;
              } else {
                const nextMarkers = cloneMarkers(tentativeMarkers);
                for (const candidate of proposal.staged) {
                  nextMarkers.set(candidate.path, {
                    identity: candidate.identity,
                    digest: candidate.digest,
                    unchangedPollsSinceValidation: 0,
                  });
                }
                if (proposal.artifacts.length > 0) {
                  if (!active(budget)) return;
                  yield Object.freeze({ kind: "batch" as const, artifacts: proposal.artifacts });
                  if (!active(budget)) return;
                  artifactsYielded += proposal.artifacts.length;
                }
                tentativeLastDigest = proposal.lastDigest;
                tentativeMarkers.clear();
                for (const [path, marker] of nextMarkers) tentativeMarkers.set(path, marker);
                break;
              }
            }
          }
        }
        if (!(await waitForPoll(ports, budget))) return;
      }
    }

    if (!active(budget)) return;
    yield checkpoint(tentativeLastDigest, watermark);
    if (!active(budget)) return;
    committedMarkers = cloneMarkers(tentativeMarkers);
  }

  const source: FileImportSource = {
    id: "file-import",
    capabilities: CAPABILITIES,
    pullBatches,
    async *pull(watermark, budget) {
      for await (const event of pullBatches(watermark, budget)) {
        if (event.kind === "batch") {
          for (const artifact of event.artifacts) {
            if (!active(budget)) return;
            yield artifact;
          }
        } else {
          if (!active(budget)) return;
          yield event;
        }
      }
    },
  };
  return Object.freeze(source);
}

export function createFolderWatcher(
  watchRoots: readonly string[],
  ports: FileImportPorts,
): FileImportSource {
  return createFileImportSource({ manualPaths: [], watchRoots }, ports);
}

export async function collectReadyBatch(
  options: CollectReadyBatchOptions,
  ports: FileImportPorts,
): Promise<CollectedReadyBatch | null> {
  const source = createFileImportSource({ manualPaths: options.paths, watchRoots: [] }, ports);
  const artifacts: RawFileSourceArtifact[] = [];
  let terminal: SourceCheckpoint | null = null;
  for await (const event of source.pullBatches(options.watermark, options.budget)) {
    if (event.kind === "batch") artifacts.push(...event.artifacts);
    else terminal = event;
  }
  return terminal === null
    ? null
    : Object.freeze({ artifacts: Object.freeze(artifacts), checkpoint: terminal });
}
