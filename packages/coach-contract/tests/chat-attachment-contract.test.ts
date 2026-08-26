import { describe, expect, it } from "vitest";
import {
  AdmitChatAttachmentRequestSchema,
  AdmitPastedChatAttachmentRequestSchema,
  AttachmentAdmissionReadModelSchema,
  CHAT_ATTACHMENT_LIMITS,
  ChatAttachmentComposerReadModelSchema,
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

  it("accepts pasted image bytes only through the privileged bounded request", () => {
    expect(
      AdmitPastedChatAttachmentRequestSchema.parse({
        chatId: "desktop",
        selectionId: "selection-1",
        displayName: "Pasted image.png",
        dataBase64: "iVBORw0KGgo=",
      }),
    ).toMatchObject({ displayName: "Pasted image.png" });
    expect(() =>
      AdmitPastedChatAttachmentRequestSchema.parse({
        chatId: "desktop",
        selectionId: "selection-1",
        displayName: "Pasted image.png",
        bytes: [137, 80, 78, 71],
      }),
    ).toThrow();
  });

  it("projects a strict path-free restored Composer draft", () => {
    const value = ChatAttachmentComposerReadModelSchema.parse({
      schemaVersion: 1,
      capabilities: {
        schemaVersion: 1,
        active: { provider: "openai", model: "gpt-5.6-sol", transport: "ai-sdk" },
        documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
        completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
        plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
        images: {
          enabled: true,
          mediaTypes: ["image/png", "image/jpeg", "image/webp"],
          reason: "supported",
          source: "maintained_catalogue",
          checkedAt: "2026-08-26T00:00:00.000Z",
        },
      },
      draft: {
        schemaVersion: 1,
        chatId: "desktop",
        text: "Review this ride",
        state: "restored",
        updatedAt: "2026-08-26T00:00:00.000Z",
        attachments: [
          {
            schemaVersion: 1,
            attachmentId: "attachment-1",
            displayName: "ride.fit",
            kind: "activity",
            extension: "fit",
            byteSize: 42,
            status: "ready",
            preview: {
              kind: "activity",
              sourceFormat: "fit",
              sessions: [
                {
                  sport: "cycling",
                  startUtc: 1_777_000_000,
                  durationSeconds: 3_600,
                  distanceMeters: 31_000,
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(value)).not.toContain("sourcePath");
    expect(() =>
      ChatAttachmentComposerReadModelSchema.parse({
        ...value,
        draft: { ...value.draft, sourcePath: "/private/ride.fit" },
      }),
    ).toThrow();
  });
});
