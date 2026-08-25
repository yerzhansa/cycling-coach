import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createChatAttachmentRepository,
  runMigrations,
  type ChatAttachmentObjectRow,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import {
  ManagedAttachmentSourceError,
  chatAttachmentRelativePath,
  createManagedChatAttachmentStore,
} from "../src/chat-attachments/index.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const LIMITS = { document: 1024, activity: 1024, workout: 1024, image: 1024 } as const;
const KEY = "a".repeat(64);

describe("managed Chat attachment store", () => {
  let root: string;
  let archiveDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "managed-chat-attachments-"));
    archiveDir = join(root, "archive");
    await mkdir(archiveDir, { mode: 0o700 });
  });

  afterEach(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("copies a signature-validated source into a durable private object", async () => {
    const sourcePath = join(root, "notes.txt");
    await writeFile(sourcePath, "steady ride\n", { mode: 0o600 });
    const managed = createManagedChatAttachmentStore({ archiveDir, kindByteLimits: LIMITS });
    const source = await managed.inspectNativeSource(sourcePath);
    expect(source).toMatchObject({
      displayName: "notes.txt",
      extension: "txt",
      kind: "document",
      mediaType: "text/plain",
      byteSize: 12,
    });
    const relativePath = chatAttachmentRelativePath(KEY, "object-1");
    await managed.copyInspectedSource({ source, relativePath });
    const target = join(archiveDir, ...relativePath.split("/"));
    await expect(readFile(target, "utf8")).resolves.toBe("steady ride\n");
    await expect(
      managed.readObjectBytes({
        relativePath,
        byteSize: source.byteSize,
        sha256: source.sha256,
      }),
    ).resolves.toEqual(Buffer.from("steady ride\n"));
    if (process.platform !== "win32") {
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(archiveDir, "chat-attachments"))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(archiveDir, "chat-attachments", KEY))).mode & 0o777).toBe(0o700);
    }
    await writeFile(target, "tamper ride\n");
    await expect(
      managed.readObjectBytes({
        relativePath,
        byteSize: source.byteSize,
        sha256: source.sha256,
      }),
    ).rejects.toBeInstanceOf(ManagedAttachmentSourceError);
  });

  it("rejects unknown extensions, signature mismatches, invalid UTF-8, and links", async () => {
    const managed = createManagedChatAttachmentStore({ archiveDir, kindByteLimits: LIMITS });
    const unknown = join(root, "ride.xyz");
    await writeFile(unknown, "data");
    await expect(managed.inspectNativeSource(unknown)).rejects.toMatchObject({
      reason: "format_unsupported",
    });

    const fakePdf = join(root, "report.pdf");
    await writeFile(fakePdf, "not a pdf");
    await expect(managed.inspectNativeSource(fakePdf)).rejects.toMatchObject({
      reason: "signature_mismatch",
    });

    const invalidText = join(root, "invalid.txt");
    await writeFile(invalidText, Buffer.from([0xc3, 0x28]));
    await expect(managed.inspectNativeSource(invalidText)).rejects.toMatchObject({
      reason: "validation_failed",
    });

    const target = join(root, "target.txt");
    const linked = join(root, "linked.txt");
    await writeFile(target, "private");
    await symlink(target, linked);
    await expect(managed.inspectNativeSource(linked)).rejects.toMatchObject({
      reason: "unsafe_source",
    });
  });

  it("detects a source identity change between inspection and copying", async () => {
    const sourcePath = join(root, "notes.txt");
    await writeFile(sourcePath, "first");
    const managed = createManagedChatAttachmentStore({ archiveDir, kindByteLimits: LIMITS });
    const source = await managed.inspectNativeSource(sourcePath);
    await writeFile(sourcePath, "second version");
    await expect(
      managed.copyInspectedSource({
        source,
        relativePath: chatAttachmentRelativePath(KEY, "object-1"),
      }),
    ).rejects.toBeInstanceOf(ManagedAttachmentSourceError);
  });

  it("rejects a linked managed root and supports the authenticated Windows path policy", async () => {
    const sourcePath = join(root, "notes.txt");
    const outside = join(root, "outside");
    await writeFile(sourcePath, "private");
    await mkdir(outside);
    await symlink(outside, join(archiveDir, "chat-attachments"));
    const posix = createManagedChatAttachmentStore({ archiveDir, kindByteLimits: LIMITS });
    const source = await posix.inspectNativeSource(sourcePath);
    await expect(
      posix.copyInspectedSource({
        source,
        relativePath: chatAttachmentRelativePath(KEY, "object-linked"),
      }),
    ).rejects.toThrow("managed attachment directory is unsafe");
    await rm(join(archiveDir, "chat-attachments"));

    const windows = createManagedChatAttachmentStore({
      archiveDir,
      kindByteLimits: LIMITS,
      platform: "win32",
    });
    await windows.copyInspectedSource({
      source,
      relativePath: chatAttachmentRelativePath(KEY, "object-windows"),
    });
    await expect(
      readFile(join(archiveDir, "chat-attachments", KEY, "object-windows"), "utf8"),
    ).resolves.toBe("private");
  });

  it("stages pasted bytes privately and enforces the format byte limit before writing", async () => {
    const managed = createManagedChatAttachmentStore({
      archiveDir,
      kindByteLimits: { ...LIMITS, document: 4 },
      randomBytes: ((size: number) =>
        Buffer.alloc(size, 1)) as typeof import("node:crypto").randomBytes,
    });
    await expect(
      managed.stagePrivateBytes({ displayName: "note.txt", bytes: Buffer.from("12345") }),
    ).rejects.toMatchObject({ reason: "file_too_large" });
    const staged = await managed.stagePrivateBytes({
      displayName: "note.txt",
      bytes: Buffer.from("1234"),
    });
    expect(staged.displayName).toBe("note.txt");
    await expect(readFile(staged.sourcePath, "utf8")).resolves.toBe("1234");
    if (process.platform !== "win32")
      expect((await lstat(staged.sourcePath)).mode & 0o777).toBe(0o600);
  });

  it("reconciles missing metadata bytes, interrupted reservations, and aged orphan bytes", async () => {
    const store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    const repository = createChatAttachmentRepository(store);
    const managed = createManagedChatAttachmentStore({
      archiveDir,
      kindByteLimits: LIMITS,
      now: () => 200_000,
    });
    const durableSource = join(root, "durable.txt");
    await writeFile(durableSource, "durable");
    const inspected = await managed.inspectNativeSource(durableSource);
    const durable: ChatAttachmentObjectRow = {
      id: "object-durable",
      conversation_id: "chat-a",
      conversation_key: KEY,
      sha256: inspected.sha256,
      byte_size: inspected.byteSize,
      relative_path: chatAttachmentRelativePath(KEY, "object-durable"),
      status: "reserved",
      failure_code: null,
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    await repository.reserveObject({
      object: durable,
      limits: {
        attachmentsPerMessage: 5,
        messageBytes: 100,
        conversationBytes: 100,
        athleteBytes: 200,
      },
    });
    await repository.commitAdmission({
      objectId: durable.id,
      attachment: {
        id: "attachment-durable",
        schema_version: 1,
        conversation_id: "chat-a",
        object_id: durable.id,
        kind: "document",
        display_name: "durable.txt",
        media_type: "text/plain",
        extension: "txt",
        byte_size: inspected.byteSize,
        sha256: inspected.sha256,
        status: "preprocessing",
        state_json: null,
        message_id: null,
        created_at_ms: 2,
        updated_at_ms: 2,
      },
      draftUpdatedAtMs: 2,
    });
    const interrupted: ChatAttachmentObjectRow = {
      ...durable,
      id: "object-interrupted",
      sha256: "b".repeat(64),
      relative_path: chatAttachmentRelativePath(KEY, "object-interrupted"),
      status: "reserved",
    };
    await repository.reserveObject({
      object: interrupted,
      limits: {
        attachmentsPerMessage: 5,
        messageBytes: 100,
        conversationBytes: 100,
        athleteBytes: 200,
      },
    });
    const orphanDir = join(archiveDir, "chat-attachments", KEY);
    await mkdir(orphanDir, { recursive: true, mode: 0o700 });
    const orphan = join(orphanDir, "orphan-object");
    const youngOrphan = join(orphanDir, "young-orphan");
    await writeFile(orphan, "orphan");
    await writeFile(youngOrphan, "young");
    await utimes(orphan, new Date(0), new Date(0));

    await expect(managed.reconcile(repository, 1_000)).resolves.toEqual({
      missing: 1,
      interruptedReservations: 1,
      orphansRemoved: 1,
    });
    await expect(repository.readObject("object-durable")).resolves.toMatchObject({
      status: "failed",
      failure_code: "managed_bytes_missing",
    });
    await expect(repository.readObject("object-interrupted")).resolves.toBeUndefined();
    await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(youngOrphan, "utf8")).resolves.toBe("young");
    await expect(repository.readAttachment("attachment-durable")).resolves.toMatchObject({
      status: "failed",
    });
    await store.close();
  });
});
