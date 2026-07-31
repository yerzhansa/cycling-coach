import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalJson, toHex, type ArchiveManager } from "@enduragent/kernel/archive";
import {
  parseReferenceCaptureManifest,
  serializeReferenceCaptureManifest,
  validateReferenceCaptureManifest,
  type ReferenceCaptureManifest,
  type SnapshotRef,
} from "@enduragent/kernel/reference/capture";
import type { CryptoPort } from "@enduragent/kernel/ports";
import { z } from "zod";
import { ensurePrivateDirectory, nodeFileSystem } from "../filesystem/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_PATH = /^[0-9]{4}\/[0-9]{2}\/[0-9a-f]{64}\.json\.gz$/;

function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

const ReviewSchema = z.object({
  schema_version: z.literal(1),
  capture_id: z.string().regex(UUID),
  reviewed_on: z.string().refine(realDate, "must be a real civil date"),
  replaces_capture_id: z.string().regex(UUID).nullable(),
  reason: z.enum(["initial", "provider-refresh", "schema-change", "capture-invalid", "operator-request"]),
}).strict().superRefine((value, context) => {
  if (value.reason === "initial" && value.replaces_capture_id !== null) {
    context.addIssue({ code: "custom", message: "initial review cannot replace a capture", path: ["replaces_capture_id"] });
  }
  if (value.reason !== "initial" && (value.replaces_capture_id === null || value.replaces_capture_id === value.capture_id)) {
    context.addIssue({ code: "custom", message: "replacement review is invalid", path: ["replaces_capture_id"] });
  }
});

export type ReferenceCaptureReview = z.infer<typeof ReviewSchema>;

export function validateReferenceCaptureReview(value: unknown): ReferenceCaptureReview {
  return ReviewSchema.parse(value);
}

export function serializeReferenceCaptureReview(value: unknown): string {
  return `${canonicalJson(validateReferenceCaptureReview(value))}\n`;
}

export function parseReferenceCaptureReview(bytes: string | Uint8Array): ReferenceCaptureReview {
  let text: string;
  try { text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError("capture review encoding is invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("capture review JSON is invalid"); }
  const value = validateReferenceCaptureReview(parsed);
  if (serializeReferenceCaptureReview(value) !== text) throw new TypeError("capture review bytes are not canonical");
  return value;
}

function validateSnapshotRef(reference: SnapshotRef): void {
  if (reference === null || typeof reference !== "object" || !HEX.test(reference.address)
    || !SNAPSHOT_PATH.test(reference.rel_path)
    || reference.rel_path.split("/").at(-1) !== `${reference.address}.json.gz`) {
    throw new TypeError("Reference snapshot is invalid");
  }
}

export async function readVerifiedReferenceSnapshot(
  reference: SnapshotRef,
  dependencies: { readonly archive: ArchiveManager; readonly crypto: CryptoPort },
): Promise<unknown> {
  validateSnapshotRef(reference);
  const compressed = await dependencies.archive.readArtifact(reference.rel_path);
  if (toHex(await dependencies.crypto.sha256(compressed)) !== reference.address) {
    throw new Error("Reference snapshot address differs");
  }
  let raw: Uint8Array;
  try { raw = new Uint8Array(gunzipSync(compressed)); }
  catch { throw new TypeError("Reference snapshot compression is invalid"); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new TypeError("Reference snapshot encoding is invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("Reference snapshot JSON is invalid"); }
  if (canonicalJson(parsed) !== text) throw new TypeError("Reference snapshot bytes are not canonical");
  return parsed;
}

export type AssertReferenceCaptureReplayable = (manifest: ReferenceCaptureManifest) => Promise<void>;

export interface ReferenceCaptureSidecars {
  readonly manifest: ReferenceCaptureManifest;
  readonly review: ReferenceCaptureReview;
}

function captureDirectory(root: string, captureId: string): string {
  if (typeof root !== "string" || root.length === 0 || !UUID.test(captureId)) {
    throw new TypeError("capture sidecar location is invalid");
  }
  return join(root, "captures", captureId);
}

async function assertCommittedMode(path: string, kind: "directory" | "file", mode: number): Promise<void> {
  const value = await lstat(path);
  if ((kind === "directory" ? !value.isDirectory() : !value.isFile()) || (value.mode & 0o777) !== mode) {
    throw new Error("capture sidecar mode is invalid");
  }
}

export async function loadReferenceCaptureSidecars(input: {
  readonly root: string;
  readonly captureId: string;
  readonly assertReplayable: AssertReferenceCaptureReplayable;
}): Promise<ReferenceCaptureSidecars> {
  if (typeof input.assertReplayable !== "function") throw new TypeError("capture replay assertion is invalid");
  const captures = join(input.root, "captures");
  const directory = captureDirectory(input.root, input.captureId);
  const manifestPath = join(directory, "manifest.json"), reviewPath = join(directory, "review.json");
  await assertCommittedMode(captures, "directory", 0o700);
  await assertCommittedMode(directory, "directory", 0o700);
  await assertCommittedMode(manifestPath, "file", 0o444);
  await assertCommittedMode(reviewPath, "file", 0o444);
  const fs = nodeFileSystem();
  const manifest = parseReferenceCaptureManifest(await fs.readFile(manifestPath));
  const review = parseReferenceCaptureReview(await fs.readFile(reviewPath));
  if (manifest.capture_id !== input.captureId || review.capture_id !== input.captureId) {
    throw new Error("capture sidecar IDs disagree");
  }
  await input.assertReplayable(manifest);
  return Object.freeze({ manifest, review });
}

export async function writeReferenceCaptureSidecars(input: {
  readonly root: string;
  readonly manifest: ReferenceCaptureManifest;
  readonly review: ReferenceCaptureReview;
  readonly assertReplayable: AssertReferenceCaptureReplayable;
}, dependencies?: { readonly beforeRename?: () => void | Promise<void> }): Promise<ReferenceCaptureSidecars> {
  if (typeof input.assertReplayable !== "function") throw new TypeError("capture replay assertion is invalid");
  const manifest = validateReferenceCaptureManifest(input.manifest);
  const review = validateReferenceCaptureReview(input.review);
  if (manifest.capture_id !== review.capture_id) throw new Error("capture sidecar IDs disagree");
  if (review.replaces_capture_id !== null) {
    await loadReferenceCaptureSidecars({ root: input.root, captureId: review.replaces_capture_id,
      assertReplayable: input.assertReplayable });
  }
  const captures = join(input.root, "captures");
  const finalDirectory = captureDirectory(input.root, manifest.capture_id);
  const pendingName = `.pending-${manifest.capture_id}`;
  const pendingDirectory = join(captures, pendingName);
  await ensurePrivateDirectory(input.root);
  await ensurePrivateDirectory(captures);
  await assertCommittedMode(captures, "directory", 0o700);
  try { await lstat(finalDirectory); throw new Error("capture sidecars already exist"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await lstat(pendingDirectory); throw new Error("capture sidecar pending directory already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  let createdPending = false;
  let renamed = false;
  try {
    await mkdir(pendingDirectory, { mode: 0o700 });
    createdPending = true;
    const fs = nodeFileSystem();
    const manifestPath = join(pendingDirectory, "manifest.json");
    const reviewPath = join(pendingDirectory, "review.json");
    await fs.writeFile(manifestPath, serializeReferenceCaptureManifest(manifest), { mode: 0o444 });
    await fs.writeFile(reviewPath, serializeReferenceCaptureReview(review), { mode: 0o444 });
    await chmod(manifestPath, 0o444);
    await chmod(reviewPath, 0o444);
    await chmod(pendingDirectory, 0o700);
    await input.assertReplayable(manifest);
    await dependencies?.beforeRename?.();
    await rename(pendingDirectory, finalDirectory);
    renamed = true;
    await chmod(finalDirectory, 0o700);
  } catch (error) {
    if (createdPending && !renamed) {
      if (pendingName !== `.pending-${manifest.capture_id}` || !pendingDirectory.startsWith(`${captures}/`)) {
        throw new Error("capture pending cleanup target is invalid", { cause: error });
      }
      try { await rm(pendingDirectory, { recursive: true }); } catch {}
    }
    throw error;
  }
  return loadReferenceCaptureSidecars({ root: input.root, captureId: manifest.capture_id,
    assertReplayable: input.assertReplayable });
}
