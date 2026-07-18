import type { ModelMessage } from "ai";

export function messageText(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : "";
}
