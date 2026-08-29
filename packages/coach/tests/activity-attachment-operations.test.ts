import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_ATTACHMENT_LIMITS } from "@enduragent/coach-contract";
import { createChatAttachmentRepository, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import {
  createManagedActivityReader,
  createManagedChatAttachmentStore,
} from "@enduragent/kernel-node/chat-attachments";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  ActivityAttachmentInterruption,
  createActivityAttachmentOperations,
  type ActivityAttachmentHooks,
} from "../src/activity-attachment-operations.js";
import { createManagedChatAttachmentOperations } from "../src/attachment-operations.js";

const roots: string[] = [];
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../kernel-node/tests/fixtures/ingest/brick-cycling.fit",
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "chat-activity-"));
  roots.push(root);
  const archiveDir = join(root, "archive");
  await mkdir(archiveDir, { mode: 0o700 });
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  const repository = createChatAttachmentRepository(store);
  const objects = createManagedChatAttachmentStore({
    archiveDir,
    kindByteLimits: {
      document: CHAT_ATTACHMENT_LIMITS.documentBytes,
      activity: CHAT_ATTACHMENT_LIMITS.activityBytes,
      workout: CHAT_ATTACHMENT_LIMITS.workoutBytes,
      image: CHAT_ATTACHMENT_LIMITS.imageBytes,
    },
  });
  const reader = createManagedActivityReader({
    objects,
    limits: {
      activityBytes: CHAT_ATTACHMENT_LIMITS.activityBytes,
      parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
      parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
      sessions: 256,
    },
  });
  const importer = createNodeImportRuntime({ archiveDir, store });
  let clock = 1_000;
  const now = () => ++clock;
  const create = (hooks?: ActivityAttachmentHooks) =>
    createActivityAttachmentOperations({
      repository,
      reader,
      importer,
      store,
      runExclusive: (work) => work(),
      now,
      ...(hooks === undefined ? {} : { hooks }),
    });
  const initial = create();
  const attachments = createManagedChatAttachmentOperations({
    repository,
    objects,
    runExclusive: (work) => work(),
    now,
    randomId: (() => {
      let sequence = 0;
      return () => `attachment-id-${++sequence}`;
    })(),
    onAdmitted: initial.preprocessAdmitted,
  });
  const staged = await objects.stagePrivateBytes({
    displayName: "ride.fit",
    bytes: new Uint8Array(await readFile(fixturePath)),
  });
  const admitted = await attachments.admit({
    chatId: "chat-1",
    selectionId: "selection-1",
    source: "picker",
    candidate: { kind: "native-path", sourcePath: staged.sourcePath },
  });
  expect(admitted.status).toBe("accepted");
  if (admitted.status !== "accepted") throw new Error("fixture admission failed");
  expect(await repository.readAttachment(admitted.attachmentId)).toMatchObject({
    kind: "activity",
    status: "ready",
    state_json: expect.stringContaining("parsed-activity"),
    message_id: null,
  });
  return {
    store,
    repository,
    attachments,
    attachmentId: admitted.attachmentId,
    create,
  };
}

const queuedTurn = {
  chatId: "chat-1",
  messages: [{ messageId: "message-1", attachmentIds: [] as string[] }],
} as const;

describe("completed activity attachments", () => {
  it("imports only after Send, supplies normalized canonical summaries, and marks the attachment sent", async () => {
    const value = await harness();
    expect(Number((await value.store.get("SELECT COUNT(*) AS count FROM session"))?.count)).toBe(0);
    const request = {
      ...queuedTurn,
      messages: [{ messageId: "message-1", attachmentIds: [value.attachmentId] }],
    };
    const operations = value.create();
    const prepared = await operations.turnPort.prepareQueuedTurn(request);
    expect(prepared.activities).toMatchObject([
      {
        attachmentId: value.attachmentId,
        messageId: "message-1",
        activityIds: [expect.any(String)],
        sessions: [
          {
            activityId: expect.any(String),
            sport: "cycling",
            startUtc: expect.any(Number),
          },
        ],
      },
    ]);
    expect(await value.repository.readAttachment(value.attachmentId)).toMatchObject({
      status: "imported",
      message_id: "message-1",
    });
    await operations.turnPort.completeQueuedTurn({ chatId: "chat-1", messageIds: ["message-1"] });
    expect(await value.repository.readAttachment(value.attachmentId)).toMatchObject({
      status: "sent",
    });
    await value.store.close();
  });

  it.each([
    ["before-message-link", "beforeMessageLink", "ready", 0],
    ["before-import", "beforeImport", "importing", 0],
    ["after-import", "afterImport", "importing", 1],
    ["before-coach-start", "beforeCoachStart", "imported", 1],
  ] as const)(
    "resumes exactly once after an interruption %s",
    async (checkpoint, hookName, expectedStatus, expectedSessions) => {
      const value = await harness();
      const hook = async () => {
        throw new ActivityAttachmentInterruption(checkpoint);
      };
      const interrupted = value.create({ [hookName]: hook });
      const request = {
        ...queuedTurn,
        messages: [{ messageId: "message-1", attachmentIds: [value.attachmentId] }],
      };
      await expect(interrupted.turnPort.prepareQueuedTurn(request)).rejects.toBeInstanceOf(
        ActivityAttachmentInterruption,
      );
      expect(await value.repository.readAttachment(value.attachmentId)).toMatchObject({
        status: expectedStatus,
      });
      expect(Number((await value.store.get("SELECT COUNT(*) AS count FROM session"))?.count)).toBe(
        expectedSessions,
      );

      const resumed = value.create();
      const result = await resumed.turnPort.prepareQueuedTurn(request);
      expect(result.activities).toHaveLength(1);
      expect(Number((await value.store.get("SELECT COUNT(*) AS count FROM session"))?.count)).toBe(
        1,
      );
      expect(await value.repository.listMessageAttachments("message-1")).toHaveLength(1);
      await value.store.close();
    },
  );

  it("deletes Conversation-owned bytes while retaining the imported Training activity", async () => {
    const value = await harness();
    await value.create().turnPort.prepareQueuedTurn({
      ...queuedTurn,
      messages: [{ messageId: "message-1", attachmentIds: [value.attachmentId] }],
    });
    const activityId = String(
      (await value.store.get("SELECT session_key FROM session LIMIT 1"))?.session_key,
    );
    await value.attachments.cleanupAttachments("chat-1", [value.attachmentId]);
    expect(await value.repository.readAttachment(value.attachmentId)).toBeUndefined();
    expect(
      await value.store.get("SELECT session_key FROM session WHERE session_key=?", [activityId]),
    ).toMatchObject({ session_key: activityId });
    await value.store.close();
  });
});
