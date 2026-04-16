import type { ModelMessage } from "ai";

export function limitHistoryTurns(messages: ModelMessage[], limit: number): ModelMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) return messages;
  let userCount = 0;
  let lastUserIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}
