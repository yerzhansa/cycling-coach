import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentCapabilitiesReadModel } from "@enduragent/coach-contract";
import { createChatAttachmentRepository, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createManagedChatAttachmentStore } from "@enduragent/kernel-node/chat-attachments";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createAttachmentComposerOperations } from "../src/attachment-composer-operations.js";
import { createManagedChatAttachmentOperations } from "../src/attachment-operations.js";

const CAPABILITIES: AttachmentCapabilitiesReadModel = {
  schemaVersion: 1,
  active: { provider: "test", model: "text-only", transport: "test" },
  documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
  completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
  plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
  images: {
    enabled: false,
    mediaTypes: [],
    reason: "model_incompatible",
    source: "maintained_catalogue",
    checkedAt: "2026-08-26T00:00:00.000Z",
  },
};

describe("attachment Composer operations", () => {
  let root: string;
  let store: ReturnType<typeof openSqliteStorage>;

  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "attachment-composer-"));
    await mkdir(join(root, "archive"), { mode: 0o700 });
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("restores text and a safe document preview without exposing its managed path", async () => {
    const sourcePath = join(root, "training-notes.txt");
    await writeFile(sourcePath, "Keep Friday easy.");
    const repository = createChatAttachmentRepository(store);
    const objects = createManagedChatAttachmentStore({
      archiveDir: join(root, "archive"),
      kindByteLimits: { document: 100, activity: 100, workout: 100, image: 100 },
    });
    const ids = ["object-1", "attachment-1"];
    const attachments = createManagedChatAttachmentOperations({
      repository,
      objects,
      runExclusive: (work) => work(),
      now: () => 1_777_000_000_000,
      randomId: () => ids.shift()!,
    });
    const admitted = await attachments.admit({
      chatId: "desktop",
      selectionId: "selection-1",
      source: "picker",
      candidate: { kind: "native-path", sourcePath },
    });
    if (admitted.status !== "accepted") throw new TypeError("fixture admission failed");
    await repository.transitionAttachment({
      conversationId: "desktop",
      attachmentId: admitted.attachmentId,
      from: ["preprocessing"],
      to: "ready",
      stateJson: JSON.stringify({
        kind: "managed-document",
        objectId: "object-1",
        reader: "text",
        readerVersion: "1",
        extractedTextSha256: "a".repeat(64),
        extractedTextChars: 17,
        visualPageNumbers: [],
      }),
      messageId: null,
      updatedAtMs: 1_777_000_000_001,
    });
    await attachments.saveDraftText("desktop", "Summarize this");

    const operations = createAttachmentComposerOperations({
      repository,
      attachments,
      activities: { readPreview: vi.fn() },
      workouts: { readWorkoutSet: vi.fn(), selectWorkout: vi.fn() },
      capabilities: async () => CAPABILITIES,
    });
    const restored = await operations.read("desktop");
    expect(restored).toMatchObject({
      draft: {
        chatId: "desktop",
        text: "Summarize this",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "training-notes.txt",
            status: "ready",
            preview: { kind: "document", extractedTextChars: 17, visualPageCount: 0 },
          },
        ],
      },
    });
    expect(JSON.stringify(restored)).not.toContain(sourcePath);

    await expect(operations.remove("desktop", "attachment-1")).resolves.toMatchObject({
      draft: { text: "Summarize this", attachments: [] },
    });
    await expect(operations.clear("desktop")).resolves.toMatchObject({ draft: null });
  });
});
