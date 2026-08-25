import type { ModelMessage } from "ai";
import type { ChatNativeMediaInput } from "./host-ports.js";

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validate(input: ChatNativeMediaInput): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.attachmentId)) {
    throw new TypeError("attachmentId is invalid");
  }
  if (
    input.mediaType !== "image/png" &&
    input.mediaType !== "image/jpeg" &&
    input.mediaType !== "image/webp"
  ) {
    throw new TypeError("mediaType is invalid");
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1) {
    throw new TypeError("native media bytes are invalid");
  }
  positiveInteger(input.width, "width");
  positiveInteger(input.height, "height");
  if (input.pageNumber !== undefined) positiveInteger(input.pageNumber, "pageNumber");
}

/**
 * Builds the one provider-facing user message that may contain binary media.
 * Callers retain only attachment metadata; this message must never be written
 * to canonical Chat history.
 */
export function createNativeMediaUserMessage(
  text: string,
  media: readonly ChatNativeMediaInput[],
): ModelMessage {
  if (media.length === 0) return { role: "user", content: text };
  const content: Array<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly image: Uint8Array;
        readonly mediaType: ChatNativeMediaInput["mediaType"];
      }
  > = [{ type: "text", text }];
  for (const input of media) {
    validate(input);
    content.push({
      type: "image",
      image: Uint8Array.from(input.bytes),
      mediaType: input.mediaType,
    });
  }
  return { role: "user", content };
}

/** Attach transient media to the current athlete message without mutating the
 * text-only message array used by history, compaction, and memory flushes. */
export function attachNativeMediaToCurrentUserMessage(
  messages: readonly ModelMessage[],
  providerText: string,
  media: readonly ChatNativeMediaInput[],
): ModelMessage[] {
  let currentUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      currentUser = index;
      break;
    }
  }
  if (currentUser < 0) throw new TypeError("current user message is missing");
  const out = [...messages];
  out[currentUser] = createNativeMediaUserMessage(providerText, media);
  return out;
}
