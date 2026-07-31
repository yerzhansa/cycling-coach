import type { ModelMessage } from "ai";

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
      const text = (part as { text?: unknown }).text;
      out += typeof text === "string" ? text : JSON.stringify(part);
    }
  }
  return out;
}
