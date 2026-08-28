import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatAttachmentRepository, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createManagedChatAttachmentStore } from "@enduragent/kernel-node/chat-attachments";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createManagedChatAttachmentOperations } from "../src/attachment-operations.js";

describe("managed Chat attachment operations", () => {
  let root: string;
  let archiveDir: string;
  let store: ReturnType<typeof openSqliteStorage>;

  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "chat-attachment-operations-"));
    archiveDir = join(root, "archive");
    await mkdir(archiveDir, { mode: 0o700 });
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  function createOperations(
    ids: readonly string[],
    observe?: Parameters<typeof createManagedChatAttachmentOperations>[0]["observe"],
    beforeConversationCleanup?: Parameters<
      typeof createManagedChatAttachmentOperations
    >[0]["beforeConversationCleanup"],
  ) {
    let index = 0;
    const repository = createChatAttachmentRepository(store);
    const objects = createManagedChatAttachmentStore({
      archiveDir,
      kindByteLimits: {
        document: 26_214_400,
        activity: 104_857_600,
        workout: 5_242_880,
        image: 20_971_520,
      },
      now: () => 100,
    });
    return {
      repository,
      operations: createManagedChatAttachmentOperations({
        repository,
        objects,
        runExclusive: (work) => work(),
        now: () => 100,
        randomId: () => ids[index++]!,
        ...(observe === undefined ? {} : { observe }),
        ...(beforeConversationCleanup === undefined ? {} : { beforeConversationCleanup }),
      }),
    };
  }

  it("returns a stable identifier only after bytes, metadata, and the draft reference are durable", async () => {
    const sourcePath = join(root, "training-notes.txt");
    await writeFile(sourcePath, "Keep Friday easy.");
    const { operations, repository } = createOperations(["object-1", "attachment-1"]);
    await expect(
      operations.admit({
        chatId: "desktop",
        selectionId: "selection-1",
        source: "picker",
        candidate: { kind: "native-path", sourcePath },
      }),
    ).resolves.toEqual({
      selectionId: "selection-1",
      displayName: "training-notes.txt",
      status: "accepted",
      attachmentId: "attachment-1",
    });
    const attachment = await repository.readAttachment("attachment-1");
    expect(attachment).toMatchObject({
      conversation_id: "desktop",
      object_id: "object-1",
      status: "preprocessing",
      extension: "txt",
    });
    const object = await repository.readObject("object-1");
    expect(object).toMatchObject({ status: "durable" });
    await expect(
      readFile(join(archiveDir, ...object!.relative_path.split("/")), "utf8"),
    ).resolves.toBe("Keep Friday easy.");
    await expect(repository.readDraft("desktop")).resolves.toMatchObject({
      text: "",
      attachmentIds: ["attachment-1"],
      state: "active",
    });
  });

  it("reuses physical bytes inside one Conversation while returning a distinct attachment identifier", async () => {
    const sourcePath = join(root, "notes.txt");
    await writeFile(sourcePath, "same bytes");
    const { operations, repository } = createOperations([
      "object-1",
      "attachment-1",
      "object-unused",
      "attachment-2",
    ]);
    const request = {
      chatId: "desktop",
      selectionId: "selection-1",
      source: "drop" as const,
      candidate: { kind: "native-path" as const, sourcePath },
    };
    await operations.admit(request);
    await expect(
      operations.admit({ ...request, selectionId: "selection-2" }),
    ).resolves.toMatchObject({
      status: "accepted",
      attachmentId: "attachment-2",
    });
    await expect(repository.listObjects()).resolves.toHaveLength(1);
    await expect(repository.readAttachment("attachment-2")).resolves.toMatchObject({
      object_id: "object-1",
    });
  });

  it("rejects unsupported content without persisting an attachment or clearing the draft", async () => {
    const sourcePath = join(root, "ride.xyz");
    await writeFile(sourcePath, "unknown");
    const { operations, repository } = createOperations([]);
    await repository.saveDraftText({
      conversationId: "desktop",
      text: "Keep this draft",
      state: "active",
      updatedAtMs: 1,
    });
    await expect(
      operations.admit({
        chatId: "desktop",
        selectionId: "selection-1",
        source: "picker",
        candidate: { kind: "native-path", sourcePath },
      }),
    ).resolves.toEqual({
      selectionId: "selection-1",
      displayName: "ride.xyz",
      status: "rejected",
      reason: "format_unsupported",
    });
    await expect(repository.listObjects()).resolves.toEqual([]);
    await expect(repository.readDraft("desktop")).resolves.toMatchObject({
      text: "Keep this draft",
    });
  });

  it("maps managed storage failures to a retryable result without exposing a path", async () => {
    const sourcePath = join(root, "notes.txt");
    await writeFile(sourcePath, "safe");
    const repository = createChatAttachmentRepository(store);
    const copyFailure = new Error("private path must not escape");
    const inspect = createManagedChatAttachmentStore({
      archiveDir,
      kindByteLimits: { document: 100, activity: 100, workout: 100, image: 100 },
    });
    const operations = createManagedChatAttachmentOperations({
      repository,
      objects: {
        ...inspect,
        copyInspectedSource: vi.fn(async () => {
          throw copyFailure;
        }),
      },
      runExclusive: (work) => work(),
      randomId: (() => {
        const ids = ["object-1", "attachment-1"];
        return () => ids.shift()!;
      })(),
    });
    const result = await operations.admit({
      chatId: "desktop",
      selectionId: "selection-1",
      source: "picker",
      candidate: { kind: "native-path", sourcePath },
    });
    expect(result).toEqual({
      selectionId: "selection-1",
      displayName: "notes.txt",
      status: "storage_failed",
      failureCode: "storage_failed",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain(sourcePath);
    await expect(repository.readObject("object-1")).resolves.toMatchObject({
      status: "failed",
      failure_code: "storage_write_failed",
    });
  });

  it("stages pasted bytes privately and removes the ingress file after durable admission", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggZFCsjqVJGJwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yNVQyMDo0MzozNSswMDowML+eSE4AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjVUMjA6NDM6MzUrMDA6MDDOw/DyAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTI1VDIwOjQzOjM1KzAwOjAwmdbRLQAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
      "base64",
    );
    const { operations, repository } = createOperations(["object-paste", "attachment-paste"]);
    await expect(
      operations.admitPasted({
        chatId: "desktop",
        selectionId: "selection-paste",
        displayName: "Pasted image.png",
        bytes: png,
      }),
    ).resolves.toMatchObject({ status: "accepted", attachmentId: "attachment-paste" });
    await expect(repository.readAttachment("attachment-paste")).resolves.toMatchObject({
      kind: "image",
      status: "preprocessing",
    });
    await expect(readdir(join(archiveDir, "chat-attachments", ".ingress"))).resolves.toEqual([]);
  });

  it("restores the same managed identifiers and draft after a database relaunch", async () => {
    const sourcePath = join(root, "relaunch.txt");
    const databasePath = join(root, "attachments.db");
    await writeFile(sourcePath, "survives relaunch");
    let persisted = openSqliteStorage(databasePath);
    await runMigrations(persisted, MIGRATIONS);
    const objects = createManagedChatAttachmentStore({
      archiveDir,
      kindByteLimits: { document: 100, activity: 100, workout: 100, image: 100 },
    });
    const firstRepository = createChatAttachmentRepository(persisted);
    const first = createManagedChatAttachmentOperations({
      repository: firstRepository,
      objects,
      runExclusive: (work) => work(),
      randomId: (() => {
        const ids = ["object-relaunch", "attachment-relaunch"];
        return () => ids.shift()!;
      })(),
    });
    await first.admit({
      chatId: "desktop",
      selectionId: "selection-relaunch",
      source: "picker",
      candidate: { kind: "native-path", sourcePath },
    });
    await firstRepository.saveDraftText({
      conversationId: "desktop",
      text: "Review after restart",
      state: "active",
      updatedAtMs: 10,
    });
    await persisted.close();

    persisted = openSqliteStorage(databasePath);
    await runMigrations(persisted, MIGRATIONS);
    const restored = createChatAttachmentRepository(persisted);
    await createManagedChatAttachmentOperations({
      repository: restored,
      objects,
      runExclusive: (work) => work(),
    }).reconcile();
    await expect(restored.readDraft("desktop")).resolves.toMatchObject({
      text: "Review after restart",
      attachmentIds: ["attachment-relaunch"],
    });
    await expect(restored.readObject("object-relaunch")).resolves.toMatchObject({
      status: "durable",
    });
    await persisted.close();
  });

  it("removes unsent bytes and Conversation-owned bytes through idempotent cleanup", async () => {
    const firstPath = join(root, "first.txt");
    const secondPath = join(root, "second.txt");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "second");
    const observations: unknown[] = [];
    const { operations, repository } = createOperations(
      ["object-1", "attachment-1", "object-2", "attachment-2"],
      (value) => observations.push(value),
    );
    await operations.admit({
      chatId: "desktop",
      selectionId: "s1",
      source: "picker",
      candidate: { kind: "native-path", sourcePath: firstPath },
    });
    await operations.admit({
      chatId: "desktop",
      selectionId: "s2",
      source: "picker",
      candidate: { kind: "native-path", sourcePath: secondPath },
    });
    const firstObject = (await repository.readObject("object-1"))!;
    await operations.removeDraftAttachment("desktop", "attachment-1");
    await expect(
      readFile(join(archiveDir, ...firstObject.relative_path.split("/"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await operations.cleanupConversation("desktop");
    await operations.cleanupConversation("desktop");
    await expect(repository.listObjects()).resolves.toEqual([]);
    expect(observations).toEqual([
      {
        operation: "cleanup",
        kind: "unknown",
        result: "succeeded",
        count: 1,
        durationMs: 0,
      },
      {
        operation: "cleanup",
        kind: "unknown",
        result: "succeeded",
        count: 0,
        durationMs: 0,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("desktop");
  });

  it("keeps attachment bytes when the destination cleanup barrier fails", async () => {
    const sourcePath = join(root, "protected.txt");
    await writeFile(sourcePath, "preserve until Plan provenance is safe");
    const beforeConversationCleanup = vi.fn(async () => {
      throw new Error("destination unavailable");
    });
    const { operations, repository } = createOperations(
      ["object-protected", "attachment-protected"],
      undefined,
      beforeConversationCleanup,
    );
    await operations.admit({
      chatId: "desktop",
      selectionId: "selection-protected",
      source: "picker",
      candidate: { kind: "native-path", sourcePath },
    });
    const object = (await repository.readObject("object-protected"))!;

    await expect(operations.cleanupConversation("desktop")).rejects.toThrow(
      "destination unavailable",
    );
    expect(beforeConversationCleanup).toHaveBeenCalledWith("desktop");
    await expect(repository.readObject("object-protected")).resolves.toBeDefined();
    await expect(
      readFile(join(archiveDir, ...object.relative_path.split("/")), "utf8"),
    ).resolves.toBe("preserve until Plan provenance is safe");
  });
});
