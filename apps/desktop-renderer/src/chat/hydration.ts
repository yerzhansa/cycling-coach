import type { ChatTranscriptMessage } from "../turn-state.js";

export const TRANSCRIPT_HYDRATION_PAGE_LIMIT = 25;
export const TRANSCRIPT_HYDRATION_FAILURE_COPY = "Conversation history is temporarily unavailable.";

export interface TranscriptTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

export type TranscriptPage =
  | {
      readonly schemaVersion: 1;
      readonly status: "page";
      readonly turns: readonly TranscriptTurn[];
      readonly nextCursor: string | null;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "restart-required";
      readonly turns: readonly [];
      readonly nextCursor: null;
    };

export type TranscriptHydrationStatus = "idle" | "loading" | "ready" | "failed";
export type TranscriptHydrationChange = "none" | "initial" | "prepend" | "clear";

export interface TranscriptHydrationSnapshot {
  readonly turns: readonly TranscriptTurn[];
  readonly nextCursor: string | null;
  readonly status: TranscriptHydrationStatus;
  readonly revision: number;
  readonly change: TranscriptHydrationChange;
}

export interface TranscriptHydrator {
  start(): Promise<void>;
  loadEarlier(): Promise<void>;
  retry(): Promise<void>;
  beginReset(): void;
  resetSucceeded(): void;
  resetFailed(): void;
  dispose(): void;
}

interface FailedRequest {
  readonly cursor: string | null;
  readonly mode: "initial" | "earlier";
}

const EMPTY_HYDRATION: TranscriptHydrationSnapshot = Object.freeze({
  turns: Object.freeze([]),
  nextCursor: null,
  status: "idle",
  revision: 0,
  change: "none",
});

export function emptyTranscriptHydration(): TranscriptHydrationSnapshot {
  return EMPTY_HYDRATION;
}

function uniqueTurns(
  incoming: readonly TranscriptTurn[],
  existing: readonly TranscriptTurn[] = [],
): readonly TranscriptTurn[] {
  const seen = new Set(existing.map((turn) => turn.turnId));
  return incoming.filter((turn) => {
    if (seen.has(turn.turnId)) return false;
    seen.add(turn.turnId);
    return true;
  });
}

export function mergeHydratedMessages(
  turns: readonly TranscriptTurn[],
  liveMessages: readonly ChatTranscriptMessage[],
): readonly ChatTranscriptMessage[] {
  const liveTurnIds = new Set(
    liveMessages.flatMap((message) => (message.turnId === undefined ? [] : [message.turnId])),
  );
  const history = turns
    .filter((turn) => !liveTurnIds.has(turn.turnId))
    .flatMap((turn): readonly ChatTranscriptMessage[] => [
      {
        id: `history:athlete:${turn.turnId}`,
        turnId: turn.turnId,
        role: "athlete",
        text: turn.athleteText,
        delivery: "complete",
        historical: true,
      },
      {
        id: `history:coach:${turn.turnId}`,
        turnId: turn.turnId,
        role: "coach",
        text: turn.coachText,
        delivery: "complete",
        historical: true,
      },
    ]);
  return [...history, ...liveMessages];
}

export function createTranscriptHydrator(input: {
  readonly readPage: (request: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>;
  readonly onChange: (snapshot: TranscriptHydrationSnapshot) => void;
}): TranscriptHydrator {
  let snapshot = EMPTY_HYDRATION;
  let disposed = false;
  let resetPending = false;
  let epoch = 0;
  let task: Promise<void> | undefined;
  let failedRequest: FailedRequest | undefined;
  let interruptedRequest: FailedRequest | undefined;

  const publish = (next: TranscriptHydrationSnapshot): void => {
    snapshot = next;
    input.onChange(snapshot);
  };
  const fail = (request: FailedRequest): void => {
    failedRequest = request;
    publish({ ...snapshot, status: "failed", change: "none" });
  };
  const applyPage = (
    page: Extract<TranscriptPage, { readonly status: "page" }>,
    mode: FailedRequest["mode"],
  ): void => {
    const turns =
      mode === "initial"
        ? uniqueTurns(page.turns)
        : [...uniqueTurns(page.turns, snapshot.turns), ...snapshot.turns];
    failedRequest = undefined;
    publish({
      turns,
      nextCursor: page.nextCursor,
      status: "ready",
      revision: snapshot.revision + 1,
      change: mode === "initial" ? "initial" : "prepend",
    });
  };
  const load = (request: FailedRequest, recoverRestart: boolean): Promise<void> => {
    if (disposed || resetPending) return Promise.resolve();
    if (task !== undefined) return task;
    const requestEpoch = epoch;
    publish({ ...snapshot, status: "loading", change: "none" });
    const current = (): boolean => !disposed && !resetPending && epoch === requestEpoch;
    const pending = (async () => {
      let failureRequest = request;
      try {
        const page = await input.readPage({
          cursor: request.cursor,
          limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
        });
        if (!current()) return;
        if (page.status === "page") {
          applyPage(page, request.mode);
          return;
        }
        publish({
          turns: [],
          nextCursor: null,
          status: "loading",
          revision: snapshot.revision + 1,
          change: "clear",
        });
        if (!recoverRestart) {
          fail({ cursor: null, mode: "initial" });
          return;
        }
        failureRequest = { cursor: null, mode: "initial" };
        const newest = await input.readPage({
          cursor: null,
          limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
        });
        if (!current()) return;
        if (newest.status === "restart-required") {
          fail({ cursor: null, mode: "initial" });
          return;
        }
        applyPage(newest, "initial");
      } catch {
        if (current()) fail(failureRequest);
      }
    })();
    task = pending;
    void pending.finally(() => {
      if (task === pending) task = undefined;
    });
    return pending;
  };

  return {
    start() {
      if (snapshot.status !== "idle") return task ?? Promise.resolve();
      return load({ cursor: null, mode: "initial" }, true);
    },
    loadEarlier() {
      if (snapshot.status === "failed") return Promise.resolve();
      const cursor = snapshot.nextCursor;
      return cursor === null ? Promise.resolve() : load({ cursor, mode: "earlier" }, true);
    },
    retry() {
      const request = failedRequest;
      return request === undefined ? Promise.resolve() : load(request, true);
    },
    beginReset() {
      if (disposed || resetPending) return;
      resetPending = true;
      epoch += 1;
      interruptedRequest =
        snapshot.status === "loading"
          ? (failedRequest ?? {
              cursor: snapshot.turns.length === 0 ? null : snapshot.nextCursor,
              mode: snapshot.turns.length === 0 ? "initial" : "earlier",
            })
          : undefined;
      task = undefined;
      if (snapshot.status === "loading") {
        publish({
          ...snapshot,
          status: snapshot.turns.length === 0 ? "idle" : "ready",
          change: "none",
        });
      }
    },
    resetSucceeded() {
      if (disposed) return;
      resetPending = false;
      epoch += 1;
      failedRequest = undefined;
      interruptedRequest = undefined;
      task = undefined;
      publish({
        turns: [],
        nextCursor: null,
        status: "ready",
        revision: snapshot.revision + 1,
        change: "clear",
      });
    },
    resetFailed() {
      if (disposed) return;
      resetPending = false;
      epoch += 1;
      task = undefined;
      if (interruptedRequest !== undefined) {
        failedRequest = interruptedRequest;
        interruptedRequest = undefined;
        publish({ ...snapshot, status: "failed", change: "none" });
      }
    },
    dispose() {
      disposed = true;
      resetPending = false;
      epoch += 1;
      task = undefined;
      failedRequest = undefined;
      interruptedRequest = undefined;
    },
  };
}
