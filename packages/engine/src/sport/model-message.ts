import type { ModelMessage } from "ai";

function binaryLength(value: unknown): number | undefined {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return undefined;
}

export function messageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Non-string content used to estimate as zero, silently undercounting a
  // part-array message (tool outputs, structured parts) toward the context
  // budget. Take text parts verbatim and JSON-serialize other structured parts
  // so their size is counted rather than dropped.
  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
    } else if (part !== null && typeof part === "object") {
      const structured = part as {
        type?: unknown;
        text?: unknown;
        image?: unknown;
        data?: unknown;
        mediaType?: unknown;
      };
      if (typeof structured.text === "string") {
        out += structured.text;
      } else if (structured.type === "image") {
        const size = binaryLength(structured.image);
        out += `[image:${typeof structured.mediaType === "string" ? structured.mediaType : "unknown"}:${size ?? "external"}]`;
      } else if (structured.type === "file") {
        const size = binaryLength(structured.data);
        out += `[file:${typeof structured.mediaType === "string" ? structured.mediaType : "unknown"}:${size ?? "external"}]`;
      } else {
        out += JSON.stringify(part);
      }
    }
  }
  return out;
}
