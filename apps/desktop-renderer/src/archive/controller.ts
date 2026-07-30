import type { TranscriptPage, TranscriptTurn } from "../chat/hydration.js";

export const ARCHIVE_PAGE_LIMIT = 25;

export interface ArchivedConversationEntry {
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly reason: "explicit-reset" | "stale-reset";
  readonly turnCount: number;
}

export interface ArchivedConversationList {
  readonly schemaVersion: 1;
  readonly conversations: readonly ArchivedConversationEntry[];
  readonly truncated: boolean;
}

export type ArchiveListStatus = "idle" | "loading" | "ready" | "failed";
export type ArchiveReadingStatus = "loading" | "ready" | "failed" | "unavailable";

export interface ArchiveReadingState {
  readonly boundaryRef: string;
  readonly boundaryAt: string | null;
  readonly status: ArchiveReadingStatus;
  readonly turns: readonly TranscriptTurn[];
  readonly hasEarlier: boolean;
}

export interface ArchiveViewState {
  readonly listStatus: ArchiveListStatus;
  readonly conversations: readonly ArchivedConversationEntry[];
  readonly truncated: boolean;
  readonly reading: ArchiveReadingState | null;
}

export interface ArchiveView {
  render(state: ArchiveViewState): void;
}

export interface ArchiveController {
  refresh(): Promise<void>;
  open(boundaryRef: string): Promise<void>;
  close(): void;
  loadEarlier(): Promise<void>;
  retry(): Promise<void>;
  dispose(): void;
}

export const EMPTY_ARCHIVE_SURFACE: ArchiveViewState = Object.freeze({
  listStatus: "idle",
  conversations: Object.freeze([]),
  truncated: false,
  reading: null,
});

function uniqueTurns(
  incoming: readonly TranscriptTurn[],
  existing: readonly TranscriptTurn[],
): readonly TranscriptTurn[] {
  const seen = new Set(existing.map((turn) => turn.turnId));
  return incoming.filter((turn) => {
    if (seen.has(turn.turnId)) return false;
    seen.add(turn.turnId);
    return true;
  });
}

export function createArchiveController(input: {
  readonly listConversations: () => Promise<ArchivedConversationList>;
  readonly readPage: (request: {
    readonly boundaryRef: string;
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>;
  readonly view: ArchiveView;
}): ArchiveController {
  let state = EMPTY_ARCHIVE_SURFACE;
  let disposed = false;
  let epoch = 0;
  let listTask: Promise<void> | undefined;
  let pageTask: Promise<void> | undefined;
  let nextCursor: string | null = null;
  let failedCursor: string | null | undefined;

  const publish = (next: ArchiveViewState): void => {
    state = next;
    try {
      input.view.render(state);
    } catch {}
  };
  const publishReading = (reading: ArchiveReadingState): void => {
    publish({ ...state, reading });
  };

  const loadList = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (listTask !== undefined) return listTask;
    const requestEpoch = epoch;
    publish({ ...state, listStatus: "loading" });
    const pending = (async () => {
      try {
        const listed = await input.listConversations();
        if (disposed || epoch !== requestEpoch) return;
        publish({
          ...state,
          listStatus: "ready",
          conversations: listed.conversations,
          truncated: listed.truncated,
        });
      } catch {
        if (!disposed && epoch === requestEpoch) publish({ ...state, listStatus: "failed" });
      }
    })();
    listTask = pending;
    void pending.finally(() => {
      if (listTask === pending) listTask = undefined;
    });
    return pending;
  };

  const loadPage = (boundaryRef: string, cursor: string | null): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pageTask !== undefined) return pageTask;
    const requestEpoch = epoch;
    const reading = state.reading;
    if (reading === null || reading.boundaryRef !== boundaryRef) return Promise.resolve();
    publishReading({ ...reading, status: "loading" });
    const pending = (async () => {
      try {
        const page = await input.readPage({ boundaryRef, cursor, limit: ARCHIVE_PAGE_LIMIT });
        if (disposed || epoch !== requestEpoch) return;
        const current = state.reading;
        if (current === null || current.boundaryRef !== boundaryRef) return;
        if (page.status === "restart-required") {
          failedCursor = undefined;
          nextCursor = null;
          publishReading({
            ...current,
            status: "unavailable",
            turns: [],
            hasEarlier: false,
          });
          return;
        }
        failedCursor = undefined;
        nextCursor = page.nextCursor;
        publishReading({
          ...current,
          status: "ready",
          turns:
            cursor === null
              ? uniqueTurns(page.turns, [])
              : [...uniqueTurns(page.turns, current.turns), ...current.turns],
          hasEarlier: page.nextCursor !== null,
        });
      } catch {
        if (disposed || epoch !== requestEpoch) return;
        const current = state.reading;
        if (current === null || current.boundaryRef !== boundaryRef) return;
        failedCursor = cursor;
        publishReading({ ...current, status: "failed" });
      }
    })();
    pageTask = pending;
    void pending.finally(() => {
      if (pageTask === pending) pageTask = undefined;
    });
    return pending;
  };

  publish(state);
  return {
    refresh() {
      return loadList();
    },
    open(boundaryRef) {
      if (disposed) return Promise.resolve();
      epoch += 1;
      pageTask = undefined;
      nextCursor = null;
      failedCursor = undefined;
      const entry = state.conversations.find((value) => value.boundaryRef === boundaryRef);
      publish({
        ...state,
        reading: {
          boundaryRef,
          boundaryAt: entry?.boundaryAt ?? null,
          status: "loading",
          turns: [],
          hasEarlier: false,
        },
      });
      return loadPage(boundaryRef, null);
    },
    close() {
      if (disposed || state.reading === null) return;
      epoch += 1;
      pageTask = undefined;
      nextCursor = null;
      failedCursor = undefined;
      publish({ ...state, reading: null });
    },
    loadEarlier() {
      const reading = state.reading;
      if (disposed || reading === null || reading.status !== "ready" || nextCursor === null) {
        return Promise.resolve();
      }
      return loadPage(reading.boundaryRef, nextCursor);
    },
    retry() {
      const reading = state.reading;
      if (reading !== null) {
        if (reading.status !== "failed") return Promise.resolve();
        return loadPage(reading.boundaryRef, failedCursor ?? null);
      }
      return state.listStatus === "failed" ? loadList() : Promise.resolve();
    },
    dispose() {
      disposed = true;
      epoch += 1;
      listTask = undefined;
      pageTask = undefined;
    },
  };
}
