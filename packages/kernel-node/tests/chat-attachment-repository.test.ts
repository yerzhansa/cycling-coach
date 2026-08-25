import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  createChatAttachmentRepository,
  runMigrations,
  type ChatAttachmentObjectRow,
  type ChatAttachmentRow,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const LIMITS = {
  attachmentsPerMessage: 5,
  messageBytes: 100,
  conversationBytes: 200,
  athleteBytes: 300,
} as const;
const KEY = "a".repeat(64);

function objectRow(
  id: string,
  conversationId: string,
  sha256: string,
  byteSize = 20,
): ChatAttachmentObjectRow {
  return {
    id,
    conversation_id: conversationId,
    conversation_key: KEY,
    sha256,
    byte_size: byteSize,
    relative_path: `chat-attachments/${KEY}/${id}`,
    status: "reserved",
    failure_code: null,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

function attachmentRow(id: string, object: ChatAttachmentObjectRow): ChatAttachmentRow {
  return {
    id,
    schema_version: 1,
    conversation_id: object.conversation_id,
    object_id: object.id,
    kind: "document",
    display_name: `${id}.txt`,
    media_type: "text/plain",
    extension: "txt",
    byte_size: object.byte_size,
    sha256: object.sha256,
    status: "preprocessing",
    state_json: null,
    message_id: null,
    created_at_ms: 2,
    updated_at_ms: 2,
  };
}

describe("chat attachment repository", () => {
  let store: ReturnType<typeof openSqliteStorage>;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("reserves capacity and returns a durable duplicate only inside the same Conversation", async () => {
    const repository = createChatAttachmentRepository(store);
    const first = objectRow("object-1", "chat-a", "1".repeat(64));
    await expect(repository.reserveObject({ object: first, limits: LIMITS })).resolves.toEqual({
      kind: "reserved",
      object: first,
    });
    await repository.commitAdmission({
      objectId: first.id,
      attachment: attachmentRow("attachment-1", first),
      draftUpdatedAtMs: 3,
    });

    const duplicate = objectRow("object-2", "chat-a", first.sha256);
    await expect(
      repository.reserveObject({ object: duplicate, limits: LIMITS }),
    ).resolves.toMatchObject({
      kind: "reused",
      object: { id: first.id, status: "durable" },
    });
    const anotherConversation = objectRow("object-3", "chat-b", first.sha256);
    await expect(
      repository.reserveObject({ object: anotherConversation, limits: LIMITS }),
    ).resolves.toMatchObject({
      kind: "reserved",
      object: { id: "object-3" },
    });
  });

  it("atomically enforces Message, Conversation, and athlete capacity without evicting rows", async () => {
    const repository = createChatAttachmentRepository(store);
    const first = objectRow("object-1", "chat-a", "1".repeat(64), 60);
    await repository.reserveObject({ object: first, limits: LIMITS });
    await repository.commitAdmission({
      objectId: first.id,
      attachment: attachmentRow("attachment-1", first),
      draftUpdatedAtMs: 3,
    });

    const messageFull = objectRow("object-2", "chat-a", "2".repeat(64), 50);
    await expect(
      repository.reserveObject({ object: messageFull, limits: LIMITS }),
    ).resolves.toEqual({
      kind: "message_limit",
    });
    expect(await repository.readObject(first.id)).toMatchObject({ status: "durable" });

    await repository.linkMessage({
      conversationId: "chat-a",
      messageId: "message-1",
      attachmentIds: ["attachment-1"],
      createdAtMs: 4,
    });
    await repository.saveDraftText({
      conversationId: "chat-a",
      text: "",
      state: "active",
      updatedAtMs: 4,
    });
    await repository.removeDraftAttachment({
      conversationId: "chat-a",
      attachmentId: "attachment-1",
    });
    const conversationFull = objectRow("object-3", "chat-a", "3".repeat(64), 150);
    await expect(
      repository.reserveObject({
        object: conversationFull,
        limits: { ...LIMITS, messageBytes: 200 },
      }),
    ).resolves.toEqual({
      kind: "storage_full",
      scope: "conversation",
    });

    const athleteA = objectRow("object-4", "chat-c", "4".repeat(64), 160);
    await repository.reserveObject({ object: athleteA, limits: { ...LIMITS, messageBytes: 200 } });
    const athleteFull = objectRow("object-5", "chat-b", "5".repeat(64), 100);
    await expect(
      repository.reserveObject({ object: athleteFull, limits: LIMITS }),
    ).resolves.toEqual({
      kind: "storage_full",
      scope: "athlete",
    });
  });

  it("restores draft text and attachment identifiers together and links them to one Message", async () => {
    const repository = createChatAttachmentRepository(store);
    const object = objectRow("object-1", "chat-a", "1".repeat(64));
    await repository.reserveObject({ object, limits: LIMITS });
    const draft = await repository.commitAdmission({
      objectId: object.id,
      attachment: attachmentRow("attachment-1", object),
      draftUpdatedAtMs: 3,
    });
    expect(draft).toMatchObject({ text: "", attachmentIds: ["attachment-1"], state: "active" });
    await repository.saveDraftText({
      conversationId: "chat-a",
      text: "Please review this",
      state: "restored",
      updatedAtMs: 4,
    });
    await expect(repository.readDraft("chat-a")).resolves.toEqual({
      schemaVersion: 1,
      conversationId: "chat-a",
      text: "Please review this",
      attachmentIds: ["attachment-1"],
      state: "restored",
      updatedAtMs: 4,
    });
    const secondObject = objectRow("object-2", "chat-a", "2".repeat(64));
    await repository.reserveObject({ object: secondObject, limits: LIMITS });
    await expect(
      repository.commitAdmission({
        objectId: secondObject.id,
        attachment: attachmentRow("attachment-2", secondObject),
        draftUpdatedAtMs: 5,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      conversationId: "chat-a",
      text: "Please review this",
      attachmentIds: ["attachment-1", "attachment-2"],
      state: "active",
      updatedAtMs: 5,
    });
    await repository.linkMessage({
      conversationId: "chat-a",
      messageId: "message-1",
      attachmentIds: ["attachment-1", "attachment-2"],
      createdAtMs: 6,
    });
    await expect(repository.listMessageAttachments("message-1")).resolves.toMatchObject([
      { id: "attachment-1", object_id: "object-1", message_id: "message-1" },
      { id: "attachment-2", object_id: "object-2", message_id: "message-1" },
    ]);
  });

  it("moves attachments through strict replay-safe durable states", async () => {
    const repository = createChatAttachmentRepository(store);
    const object = objectRow("object-1", "chat-a", "1".repeat(64));
    await repository.reserveObject({ object, limits: LIMITS });
    const activity = {
      ...attachmentRow("attachment-1", object),
      kind: "activity" as const,
      display_name: "ride.fit",
      media_type: "application/vnd.ant.fit",
      extension: "fit",
    };
    await repository.commitAdmission({
      objectId: object.id,
      attachment: activity,
      draftUpdatedAtMs: 3,
    });
    const parsed = JSON.stringify({ kind: "parsed-activity", parsedActivityId: "parsed-1" });
    await expect(
      repository.transitionAttachment({
        conversationId: "chat-a",
        attachmentId: "attachment-1",
        from: ["preprocessing"],
        to: "ready",
        stateJson: parsed,
        messageId: null,
        updatedAtMs: 4,
      }),
    ).resolves.toMatchObject({ status: "ready", state_json: parsed, message_id: null });
    await repository.linkMessage({
      conversationId: "chat-a",
      messageId: "message-1",
      attachmentIds: ["attachment-1"],
      createdAtMs: 5,
    });
    await expect(
      repository.transitionAttachment({
        conversationId: "chat-a",
        attachmentId: "attachment-1",
        from: ["ready", "failed"],
        to: "importing",
        stateJson: parsed,
        messageId: "message-1",
        updatedAtMs: 6,
      }),
    ).resolves.toMatchObject({ status: "importing", message_id: "message-1" });
    await expect(
      repository.transitionAttachment({
        conversationId: "chat-a",
        attachmentId: "attachment-1",
        from: ["ready", "failed"],
        to: "importing",
        stateJson: parsed,
        messageId: "message-1",
        updatedAtMs: 6,
      }),
    ).resolves.toMatchObject({ status: "importing", updated_at_ms: 6 });

    await expect(
      repository.transitionAttachment({
        conversationId: "chat-a",
        attachmentId: "attachment-1",
        from: ["importing"],
        to: "imported",
        stateJson: JSON.stringify({ kind: "canonical-activity", activityIds: ["activity-1"] }),
        messageId: "message-2",
        updatedAtMs: 7,
      }),
    ).rejects.toMatchObject({ code: "attachment_transition_conflict" });
  });

  it("updates a ready planned-Workout selection before Message linkage only", async () => {
    const repository = createChatAttachmentRepository(store);
    const object = objectRow("object-workout", "chat-a", "9".repeat(64));
    await repository.reserveObject({ object, limits: LIMITS });
    const workout = {
      ...attachmentRow("attachment-workout", object),
      kind: "workout" as const,
      display_name: "tempo.zwo",
      media_type: "application/vnd.zwift.workout+xml",
      extension: "zwo",
    };
    await repository.commitAdmission({
      objectId: object.id,
      attachment: workout,
      draftUpdatedAtMs: 3,
    });
    const initial = JSON.stringify({
      kind: "parsed-workout-set",
      setId: "set-1",
      selectedWorkoutId: null,
    });
    await repository.transitionAttachment({
      conversationId: "chat-a",
      attachmentId: workout.id,
      from: ["preprocessing"],
      to: "ready",
      stateJson: initial,
      messageId: null,
      updatedAtMs: 4,
    });
    const selected = JSON.stringify({
      kind: "parsed-workout-set",
      setId: "set-1",
      selectedWorkoutId: "workout-1",
    });
    await expect(
      repository.updateReadyProjection({
        conversationId: "chat-a",
        attachmentId: workout.id,
        stateJson: selected,
        updatedAtMs: 5,
      }),
    ).resolves.toMatchObject({ status: "ready", state_json: selected, message_id: null });
    await expect(
      repository.updateReadyProjection({
        conversationId: "chat-a",
        attachmentId: workout.id,
        stateJson: selected,
        updatedAtMs: 5,
      }),
    ).resolves.toMatchObject({ state_json: selected, updated_at_ms: 5 });
    await repository.linkMessage({
      conversationId: "chat-a",
      messageId: "message-workout",
      attachmentIds: [workout.id],
      createdAtMs: 6,
    });
    await expect(
      repository.updateReadyProjection({
        conversationId: "chat-a",
        attachmentId: workout.id,
        stateJson: initial,
        updatedAtMs: 7,
      }),
    ).rejects.toMatchObject({ code: "attachment_projection_conflict" });
  });

  it("serializes competing reservations so aggregate capacity cannot be oversubscribed", async () => {
    const repository = createChatAttachmentRepository(store);
    const limits = {
      attachmentsPerMessage: 5,
      messageBytes: 30,
      conversationBytes: 30,
      athleteBytes: 30,
    } as const;
    const results = await Promise.all([
      repository.reserveObject({
        object: objectRow("object-a", "chat-a", "a".repeat(64), 20),
        limits,
      }),
      repository.reserveObject({
        object: objectRow("object-b", "chat-b", "b".repeat(64), 20),
        limits,
      }),
    ]);
    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "storage_full")).toEqual([
      { kind: "storage_full", scope: "athlete" },
    ]);
  });

  it("reuses the first free draft ordinal after removal", async () => {
    const repository = createChatAttachmentRepository(store);
    for (let index = 0; index < 5; index += 1) {
      const object = objectRow(`object-${index}`, "chat-a", String(index).repeat(64));
      await repository.reserveObject({ object, limits: { ...LIMITS, messageBytes: 200 } });
      await repository.commitAdmission({
        objectId: object.id,
        attachment: attachmentRow(`attachment-${index}`, object),
        draftUpdatedAtMs: index + 2,
      });
    }
    await repository.removeDraftAttachment({
      conversationId: "chat-a",
      attachmentId: "attachment-2",
    });
    const replacement = objectRow("object-new", "chat-a", "f".repeat(64));
    await repository.reserveObject({
      object: replacement,
      limits: { ...LIMITS, messageBytes: 200 },
    });
    await expect(
      repository.commitAdmission({
        objectId: replacement.id,
        attachment: attachmentRow("attachment-new", replacement),
        draftUpdatedAtMs: 10,
      }),
    ).resolves.toMatchObject({
      attachmentIds: [
        "attachment-0",
        "attachment-1",
        "attachment-new",
        "attachment-3",
        "attachment-4",
      ],
    });
  });

  it("cleans one Conversation idempotently while leaving other Conversations untouched", async () => {
    const repository = createChatAttachmentRepository(store);
    for (const [id, conversationId, digest] of [
      ["object-a", "chat-a", "a".repeat(64)],
      ["object-b", "chat-b", "b".repeat(64)],
    ] as const) {
      const object = objectRow(id, conversationId, digest);
      await repository.reserveObject({ object, limits: LIMITS });
      await repository.commitAdmission({
        objectId: id,
        attachment: attachmentRow(`attachment-${id}`, object),
        draftUpdatedAtMs: 3,
      });
    }
    await expect(repository.cleanupConversation("chat-a")).resolves.toMatchObject([
      { id: "object-a" },
    ]);
    await expect(repository.cleanupConversation("chat-a")).resolves.toEqual([]);
    await expect(repository.readObject("object-b")).resolves.toMatchObject({
      conversation_id: "chat-b",
    });
  });
});
