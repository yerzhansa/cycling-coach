import { describe, expect, it } from "vitest";
import {
  attachNativeMediaToCurrentUserMessage,
  createNativeMediaUserMessage,
} from "../src/native-media-message.js";

describe("native media provider message", () => {
  it("constructs cloned image parts for the current provider request", () => {
    const original = new Uint8Array([1, 2, 3]);
    const message = createNativeMediaUserMessage("Review this image", [
      {
        attachmentId: "attachment-1",
        mediaType: "image/png",
        bytes: original,
        width: 1,
        height: 1,
      },
    ]);
    original[0] = 9;
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Review this image" },
        { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
      ],
    });
  });

  it("keeps text-only turns in their canonical string form", () => {
    expect(createNativeMediaUserMessage("Hello", [])).toEqual({
      role: "user",
      content: "Hello",
    });
  });

  it("rejects malformed host payloads", () => {
    expect(() =>
      createNativeMediaUserMessage("Review", [
        {
          attachmentId: "../escape",
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
          width: 1,
          height: 1,
        },
      ]),
    ).toThrow("attachmentId is invalid");
  });

  it("leaves the text-only compaction and persistence array untouched", () => {
    const messages = [
      { role: "user" as const, content: "canonical athlete text" },
    ];
    const provider = attachNativeMediaToCurrentUserMessage(
      messages,
      "provider text plus untrusted document fence",
      [
        {
          attachmentId: "attachment-1",
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
          width: 1,
          height: 1,
        },
      ],
    );
    expect(messages).toEqual([{ role: "user", content: "canonical athlete text" }]);
    expect(provider[0]?.role).toBe("user");
    expect(Array.isArray(provider[0]?.content) ? provider[0].content[0] : undefined).toEqual({
      type: "text",
      text: "provider text plus untrusted document fence",
    });
  });
});
