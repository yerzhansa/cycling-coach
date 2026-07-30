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
}) {
  const states: ArchiveViewState[] = [];
  const controller = createArchiveController({
    listConversations: input.listConversations ?? (async () => list()),
    readPage: input.readPage ?? (async () => page(["turn-1"])),
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
});
