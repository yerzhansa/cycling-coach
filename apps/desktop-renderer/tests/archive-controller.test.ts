import { describe, expect, it, vi } from "vitest";
import {
  createArchiveController,
  EMPTY_ARCHIVE_SURFACE,
  type ArchivedConversationList,
  type ArchiveViewState,
} from "../src/archive/controller.js";
import type { TranscriptPage } from "../src/chat/hydration.js";

const NEWER = "a".repeat(64);
const OLDER = "b".repeat(64);
const NEWEST = "c".repeat(64);

function list(truncated = false): ArchivedConversationList {
  return {
    schemaVersion: 1,
    conversations: [
      {
        boundaryRef: NEWER,
        boundaryAt: "1998-07-19T08:00:00.000Z",
        reason: "explicit-reset",
        turnCount: 3,
      },
      {
        boundaryRef: OLDER,
        boundaryAt: "1998-07-12T07:30:00.000Z",
        reason: "stale-reset",
        turnCount: 1,
      },
    ],
    truncated,
  };
}

function refreshedList(): ArchivedConversationList {
  return {
    schemaVersion: 1,
    conversations: [
      {
        boundaryRef: NEWEST,
        boundaryAt: "1998-07-26T09:00:00.000Z",
        reason: "explicit-reset",
        turnCount: 5,
      },
      ...list().conversations,
    ],
    truncated: false,
  };
}

function page(turnIds: readonly string[], nextCursor: string | null = null): TranscriptPage {
  return {
    schemaVersion: 1,
    status: "page",
    turns: turnIds.map((turnId) => ({
      turnId,
      completedAt: "1998-07-19T07:00:00.000Z",
      athleteText: `Athlete ${turnId}`,
      coachText: `Coach ${turnId}`,
    })),
    nextCursor,
  };
}

function harness(input: {
  readonly listConversations?: () => Promise<ArchivedConversationList>;
  readonly readPage?: (request: {
    readonly boundaryRef: string;
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>;
  readonly deleteConversation?: (
    boundaryRef: string,
  ) => Promise<{ readonly schemaVersion: 1; readonly status: "deleted" | "not-found" }>;
}) {
  const states: ArchiveViewState[] = [];
  const controller = createArchiveController({
    listConversations: input.listConversations ?? (async () => list()),
    readPage: input.readPage ?? (async () => page(["turn-1"])),
    deleteConversation:
      input.deleteConversation ?? (async () => ({ schemaVersion: 1, status: "deleted" })),
    view: {
      render(state) {
        states.push(state);
      },
    },
  });
  const current = (): ArchiveViewState => states.at(-1) ?? EMPTY_ARCHIVE_SURFACE;
  return { controller, states, current };
}

describe("archive controller list", () => {
  it("publishes the newest-first list and the truncation signal", async () => {
    const subject = harness({ listConversations: async () => list(true) });

    expect(subject.current()).toEqual(EMPTY_ARCHIVE_SURFACE);
    await subject.controller.refresh();

    expect(subject.current().listStatus).toBe("ready");
    expect(subject.current().conversations.map((entry) => entry.boundaryRef)).toEqual([
      NEWER,
      OLDER,
    ]);
    expect(subject.current().truncated).toBe(true);
    expect(subject.states.map((state) => state.listStatus)).toEqual(["idle", "loading", "ready"]);
  });

  it("fails closed on a list failure and recovers through retry", async () => {
    const listConversations = vi
      .fn<() => Promise<ArchivedConversationList>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(list());
    const subject = harness({ listConversations });

    await subject.controller.refresh();
    expect(subject.current().listStatus).toBe("failed");
    expect(subject.current().conversations).toEqual([]);

    await subject.controller.retry();
    expect(subject.current().listStatus).toBe("ready");
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent list loads", async () => {
    const listConversations = vi.fn(async () => list());
    const subject = harness({ listConversations });

    await Promise.all([subject.controller.refresh(), subject.controller.refresh()]);

    expect(listConversations).toHaveBeenCalledOnce();
  });

  it("publishes a list load that resolves while a conversation is open", async () => {
    let release!: (value: ArchivedConversationList) => void;
    const deferred = new Promise<ArchivedConversationList>((resolve) => {
      release = resolve;
    });
    const listConversations = vi
      .fn<() => Promise<ArchivedConversationList>>()
      .mockResolvedValueOnce(list())
      .mockReturnValueOnce(deferred);
    const subject = harness({ listConversations });

    await subject.controller.refresh();
    const pending = subject.controller.refresh();
    await subject.controller.open(NEWER);
    release(refreshedList());
    await pending;

    expect(subject.current().listStatus).toBe("ready");
    expect(subject.current().conversations.map((entry) => entry.boundaryRef)).toEqual([
      NEWEST,
      NEWER,
      OLDER,
    ]);
    expect(subject.current().reading).toMatchObject({ boundaryRef: NEWER, status: "ready" });
  });

  it("settles a list load that resolves after the reader opened and closed", async () => {
    let release!: (value: ArchivedConversationList) => void;
    const deferred = new Promise<ArchivedConversationList>((resolve) => {
      release = resolve;
    });
    const listConversations = vi
      .fn<() => Promise<ArchivedConversationList>>()
      .mockResolvedValueOnce(list())
      .mockReturnValueOnce(deferred);
    const subject = harness({ listConversations });

    await subject.controller.refresh();
    const pending = subject.controller.refresh();
    await subject.controller.open(NEWER);
    subject.controller.close();
    release(refreshedList());
    await pending;

    expect(subject.current().reading).toBeNull();
    expect(subject.current().listStatus).toBe("ready");
    expect(subject.current().conversations.map((entry) => entry.boundaryRef)).toEqual([
      NEWEST,
      NEWER,
      OLDER,
    ]);
    expect(subject.states.map((state) => state.listStatus).at(-1)).toBe("ready");
  });

  it("surfaces a list failure that lands after the reader closed so retry is reachable", async () => {
    let reject!: (reason: Error) => void;
    const deferred = new Promise<ArchivedConversationList>((_resolve, fail) => {
      reject = fail;
    });
    const listConversations = vi
      .fn<() => Promise<ArchivedConversationList>>()
      .mockResolvedValueOnce(list())
      .mockReturnValueOnce(deferred)
      .mockResolvedValueOnce(refreshedList());
    const subject = harness({ listConversations });

    await subject.controller.refresh();
    const pending = subject.controller.refresh();
    await subject.controller.open(NEWER);
    subject.controller.close();
    reject(new Error("unavailable"));
    await pending;

    expect(subject.current().listStatus).toBe("failed");

    await subject.controller.retry();

    expect(subject.current().listStatus).toBe("ready");
    expect(subject.current().conversations.map((entry) => entry.boundaryRef)).toEqual([
      NEWEST,
      NEWER,
      OLDER,
    ]);
    expect(listConversations).toHaveBeenCalledTimes(3);
  });
});

describe("archive controller reader", () => {
  it("opens a boundary, pages earlier turns and returns to the list", async () => {
    const readPage = vi.fn(async (request: { readonly cursor: string | null }) =>
      request.cursor === null ? page(["turn-2", "turn-3"], "cursor-1") : page(["turn-1"]),
    );
    const subject = harness({ readPage });

    await subject.controller.refresh();
    await subject.controller.open(NEWER);

    expect(subject.current().reading).toMatchObject({
      boundaryRef: NEWER,
      boundaryAt: "1998-07-19T08:00:00.000Z",
      status: "ready",
      hasEarlier: true,
    });
    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual([
      "turn-2",
      "turn-3",
    ]);

    await subject.controller.loadEarlier();
    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
    ]);
    expect(subject.current().reading?.hasEarlier).toBe(false);
    expect(readPage).toHaveBeenNthCalledWith(1, { boundaryRef: NEWER, cursor: null, limit: 25 });
    expect(readPage).toHaveBeenNthCalledWith(2, {
      boundaryRef: NEWER,
      cursor: "cursor-1",
      limit: 25,
    });

    await subject.controller.loadEarlier();
    expect(readPage).toHaveBeenCalledTimes(2);

    subject.controller.close();
    expect(subject.current().reading).toBeNull();
    expect(subject.current().conversations).toHaveLength(2);
  });

  it("drops duplicate turn ids while prepending an earlier page", async () => {
    const readPage = vi.fn(async (request: { readonly cursor: string | null }) =>
      request.cursor === null ? page(["turn-2"], "cursor-1") : page(["turn-1", "turn-2"]),
    );
    const subject = harness({ readPage });

    await subject.controller.refresh();
    await subject.controller.open(NEWER);
    await subject.controller.loadEarlier();

    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("marks a superseded boundary unavailable without retry", async () => {
    const subject = harness({
      readPage: async () => ({
        schemaVersion: 1,
        status: "restart-required",
        turns: [],
        nextCursor: null,
      }),
    });

    await subject.controller.refresh();
    await subject.controller.open(OLDER);

    expect(subject.current().reading).toMatchObject({
      boundaryRef: OLDER,
      status: "unavailable",
      hasEarlier: false,
    });
    await subject.controller.retry();
    expect(subject.current().reading?.status).toBe("unavailable");
  });

  it("retries the exact failed page request", async () => {
    const readPage = vi
      .fn<
        (request: {
          readonly boundaryRef: string;
          readonly cursor: string | null;
          readonly limit: number;
        }) => Promise<TranscriptPage>
      >()
      .mockResolvedValueOnce(page(["turn-2"], "cursor-1"))
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(page(["turn-1"]));
    const subject = harness({ readPage });

    await subject.controller.refresh();
    await subject.controller.open(NEWER);
    await subject.controller.loadEarlier();
    expect(subject.current().reading?.status).toBe("failed");
    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual(["turn-2"]);

    await subject.controller.retry();

    expect(readPage).toHaveBeenNthCalledWith(3, {
      boundaryRef: NEWER,
      cursor: "cursor-1",
      limit: 25,
    });
    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("ignores a page that resolves after the reader closed or moved on", async () => {
    let release!: (page: TranscriptPage) => void;
    const first = new Promise<TranscriptPage>((resolve) => {
      release = resolve;
    });
    const readPage = vi
      .fn<
        (request: {
          readonly boundaryRef: string;
          readonly cursor: string | null;
          readonly limit: number;
        }) => Promise<TranscriptPage>
      >()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(page(["turn-9"]));
    const subject = harness({ readPage });

    await subject.controller.refresh();
    const pending = subject.controller.open(NEWER);
    const second = subject.controller.open(OLDER);
    release(page(["turn-1"]));
    await Promise.all([pending, second]);

    expect(subject.current().reading?.boundaryRef).toBe(OLDER);
    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual(["turn-9"]);

    subject.controller.dispose();
    await subject.controller.refresh();
    await subject.controller.open(NEWER);
    expect(subject.current().reading?.boundaryRef).toBe(OLDER);
  });

  it("ignores a page that resolves after the same boundary was closed and reopened", async () => {
    let release!: (page: TranscriptPage) => void;
    const first = new Promise<TranscriptPage>((resolve) => {
      release = resolve;
    });
    const readPage = vi
      .fn<
        (request: {
          readonly boundaryRef: string;
          readonly cursor: string | null;
          readonly limit: number;
        }) => Promise<TranscriptPage>
      >()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(page(["turn-9"]));
    const subject = harness({ readPage });

    await subject.controller.refresh();
    const pending = subject.controller.open(NEWER);
    subject.controller.close();
    const reopened = subject.controller.open(NEWER);
    release(page(["turn-1"]));
    await Promise.all([pending, reopened]);

    expect(subject.current().reading).toMatchObject({ boundaryRef: NEWER, status: "ready" });
    expect(subject.current().reading?.turns.map((turn) => turn.turnId)).toEqual(["turn-9"]);
    expect(readPage).toHaveBeenCalledTimes(2);
  });
});

describe("archive controller deletion", () => {
  it.each(["deleted", "not-found"] as const)(
    "treats %s as success, closes the reader, and refetches the whole list",
    async (status) => {
      const listConversations = vi
        .fn<() => Promise<ArchivedConversationList>>()
        .mockResolvedValueOnce(list(true))
        .mockResolvedValueOnce({
          schemaVersion: 1,
          conversations: [list().conversations[1]!],
          truncated: false,
        });
      const deleteConversation = vi.fn(async () => ({ schemaVersion: 1 as const, status }));
      const subject = harness({ listConversations, deleteConversation });

      await subject.controller.refresh();
      await subject.controller.open(NEWER);
      subject.controller.requestDeletion(NEWER);
      expect(subject.current().deletion).toEqual({
        boundaryRef: NEWER,
        status: "confirming",
      });

      await subject.controller.confirmDeletion();

      expect(deleteConversation).toHaveBeenCalledOnce();
      expect(deleteConversation).toHaveBeenCalledWith(NEWER);
      expect(listConversations).toHaveBeenCalledTimes(2);
      expect(subject.current()).toMatchObject({
        listStatus: "ready",
        truncated: false,
        reading: null,
        deletion: null,
      });
      expect(subject.current().conversations.map((entry) => entry.boundaryRef)).toEqual([OLDER]);
    },
  );

  it("keeps a failed deletion open for an explicit retry", async () => {
    const deleteConversation = vi
      .fn<
        () => Promise<{
          readonly schemaVersion: 1;
          readonly status: "deleted" | "not-found";
        }>
      >()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ schemaVersion: 1, status: "deleted" });
    const subject = harness({ deleteConversation });

    await subject.controller.refresh();
    await subject.controller.open(NEWER);
    subject.controller.requestDeletion(NEWER);
    await subject.controller.confirmDeletion();

    expect(subject.current().reading?.boundaryRef).toBe(NEWER);
    expect(subject.current().deletion).toEqual({ boundaryRef: NEWER, status: "failed" });

    await subject.controller.confirmDeletion();

    expect(deleteConversation).toHaveBeenCalledTimes(2);
    expect(subject.current().reading).toBeNull();
    expect(subject.current().deletion).toBeNull();
  });

  it("cancels confirmation but cannot dismiss or duplicate an in-flight deletion", async () => {
    let release!: () => void;
    const pendingDelete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleteConversation = vi.fn(async () => {
      await pendingDelete;
      return { schemaVersion: 1 as const, status: "deleted" as const };
    });
    const subject = harness({ deleteConversation });

    await subject.controller.refresh();
    await subject.controller.open(NEWER);
    subject.controller.requestDeletion(NEWER);
    subject.controller.cancelDeletion();
    expect(subject.current().deletion).toBeNull();

    subject.controller.requestDeletion(NEWER);
    const first = subject.controller.confirmDeletion();
    const second = subject.controller.confirmDeletion();
    subject.controller.cancelDeletion();
    subject.controller.close();

    expect(first).toBe(second);
    expect(deleteConversation).toHaveBeenCalledOnce();
    expect(subject.current().deletion).toEqual({ boundaryRef: NEWER, status: "deleting" });
    expect(subject.current().reading?.boundaryRef).toBe(NEWER);

    release();
    await first;
    expect(subject.current().reading).toBeNull();
  });

  it("ignores a deletion completion after disposal", async () => {
    let release!: () => void;
    const pendingDelete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subject = harness({
      deleteConversation: async () => {
        await pendingDelete;
        return { schemaVersion: 1, status: "deleted" };
      },
    });

    await subject.controller.refresh();
    await subject.controller.open(NEWER);
    subject.controller.requestDeletion(NEWER);
    const deletion = subject.controller.confirmDeletion();
    const beforeDispose = subject.current();
    subject.controller.dispose();
    release();
    await deletion;

    expect(subject.current()).toBe(beforeDispose);
  });
});
