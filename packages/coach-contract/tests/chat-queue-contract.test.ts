import { describe, expect, it } from "vitest";
import {
  ChatQueueSnapshotSchema,
  EnqueueChatMessageRequestSchema,
  PROTOCOL_VERSION,
  RunQueuedCommandRequestSchema,
} from "../src/index.js";

describe("chat queue contract", () => {
  it("ships protocol 23 and rejects blank enqueue text", () => {
    expect(PROTOCOL_VERSION).toBe(23);
    expect(() =>
      EnqueueChatMessageRequestSchema.parse({
        chatId: "desktop",
        submissionId: "submission-1",
        text: "  ",
      }),
    ).toThrow();
  });

  it("requires exact FIFO positions, unique submission ids, and a head-owned recovery claim", () => {
    const item = {
      queuedMessageId: "queued-1",
      submissionId: "submission-1",
      text: "Hello",
      kind: "ordinary" as const,
      position: 0,
      restored: true,
    };
    expect(
      ChatQueueSnapshotSchema.parse({ schemaVersion: 1, revision: 3, items: [item] }),
    ).toMatchObject({ revision: 3, items: [{ restored: true }] });
    expect(() =>
      ChatQueueSnapshotSchema.parse({
        schemaVersion: 1,
        revision: 3,
        items: [item, { ...item, queuedMessageId: "queued-2", position: 2 }],
      }),
    ).toThrow();
    expect(() =>
      ChatQueueSnapshotSchema.parse({
        schemaVersion: 1,
        revision: 3,
        items: [item],
        retryRequired: {
          claimId: "claim-1",
          queuedMessageIds: ["other"],
          turnId: "turn-1",
          status: "retry-required",
        },
      }),
    ).toThrow();
  });

  it("rejects extra command identity fields", () => {
    expect(() =>
      RunQueuedCommandRequestSchema.parse({
        chatId: "desktop",
        queuedMessageId: "queued-1",
        text: "/review",
      }),
    ).toThrow();
  });
});
