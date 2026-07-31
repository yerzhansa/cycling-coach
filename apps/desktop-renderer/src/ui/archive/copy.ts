export const ARCHIVE_TITLE = "Past chats";
export const ARCHIVE_READ_ONLY_NOTE = "Past conversations are read-only.";
export const ARCHIVE_EMPTY_COPY =
  "No past conversations yet. Starting a new conversation keeps the old one here.";
export const ARCHIVE_LOADING_COPY = "Loading past conversations…";
export const ARCHIVE_LIST_FAILURE_COPY = "Past conversations are temporarily unavailable.";
export const ARCHIVE_PAGE_FAILURE_COPY = "This conversation is temporarily unavailable.";
export const ARCHIVE_UNAVAILABLE_COPY = "This conversation is no longer available.";
export const ARCHIVE_TRUNCATED_COPY = "Only the most recent past conversations are listed.";
export const ARCHIVE_BACK_COPY = "All past chats";
export const ARCHIVE_LOAD_EARLIER_COPY = "Load earlier messages";
export const ARCHIVE_RETRY_COPY = "Try again";
export const ARCHIVE_EMPTY_CONVERSATION_COPY = "This conversation has no readable messages.";

export function archiveReasonCopy(reason: "explicit-reset" | "stale-reset"): string {
  return reason === "explicit-reset" ? "You started a new conversation" : "Closed after a break";
}

export function archiveTurnCountCopy(turnCount: number): string {
  return turnCount === 1 ? "1 message" : `${turnCount} messages`;
}

export function archiveTimestampCopy(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}
