import { describe, expect, it } from "vitest";
import {
  AdmitChatAttachmentRequestSchema,
  AttachmentAdmissionReadModelSchema,
  CHAT_ATTACHMENT_LIMITS,
} from "../src/index.js";

describe("chat attachment contract", () => {
  it("keeps all approved attachment limits in one immutable contract", () => {
    expect(CHAT_ATTACHMENT_LIMITS).toMatchObject({
      attachmentsPerMessage: 5,
      messageBytes: 104_857_600,
      conversationBytes: 1_073_741_824,
      athleteBytes: 10_737_418_240,
      parserMs: 30_000,
    });
    expect(Object.isFrozen(CHAT_ATTACHMENT_LIMITS)).toBe(true);
  });

  it("accepts only privileged native paths from picker or drop", () => {
    const request = {
      chatId: "desktop",
      selectionId: "selection-1",
      source: "picker",
      candidate: { kind: "native-path", sourcePath: "/tmp/activity.fit" },
    } as const;
    expect(AdmitChatAttachmentRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      AdmitChatAttachmentRequestSchema.parse({
        ...request,
        candidate: { kind: "native-path", sourcePath: "relative/activity.fit" },
      }),
    ).toThrow(/absolute/u);
    expect(() =>
      AdmitChatAttachmentRequestSchema.parse({
        ...request,
        source: "paste",
      }),
    ).toThrow();
  });

  it("models fail-closed admission without issuing a stable attachment id", () => {
    const result = AttachmentAdmissionReadModelSchema.parse({
      selectionId: "selection-1",
      displayName: "activity.fit",
      status: "storage_failed",
      failureCode: "admission_unavailable",
      retryable: false,
    });
    expect(result).not.toHaveProperty("attachmentId");
  });
});
