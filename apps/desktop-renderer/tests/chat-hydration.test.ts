import { describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_HYDRATION_PAGE_LIMIT,
  createTranscriptHydrator,
  mergeHydratedMessages,
  type TranscriptHydrationSnapshot,
  type TranscriptPage,
  type TranscriptTurn,
} from "../src/chat/hydration.js";
import type { ChatTranscriptMessage } from "../src/turn-state.js";

function turn(turnId: string): TranscriptTurn {
  return {
    turnId,
    completedAt: "2001-01-01T00:00:00.000Z",
    athleteText: `Athlete ${turnId}`,
    coachText: `Coach ${turnId}`,
  };
}

function page(turns: readonly TranscriptTurn[], nextCursor: string | null): TranscriptPage {
  return { schemaVersion: 1, status: "page", turns, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function subject(
  readPage: (request: { cursor: string | null; limit: number }) => Promise<TranscriptPage>,
) {
  const snapshots: TranscriptHydrationSnapshot[] = [];
  const hydrator = createTranscriptHydrator({
    readPage,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { hydrator, snapshots };
}

describe("chat transcript hydration", () => {
  it("hydrates v2 decision entries as the original athlete message and completed Coach response", async () => {
    const decision = {
      decisionId: "decision-1",
      chatId: "desktop",
      messageId: "message-1",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Keep tempo",
          description: "Keep the planned workout.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };
    const { hydrator, snapshots } = subject(async () => ({
      schemaVersion: 2,
      status: "page",
      turns: [],
      entries: [
        {
          kind: "decision-requested",
          recordedAt: "2001-01-01T00:00:00.000Z",
          athleteText: "What should I do tomorrow?",
          decision,
        },
        {
          kind: "decision-answered",
          recordedAt: "2001-01-01T00:01:00.000Z",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "recovery" },
          consequence: "Tomorrow becomes a recovery day.",
          continuationId: "continuation-1",
        },
        {
          kind: "decision-continuation-completed",
          recordedAt: "2001-01-01T00:02:00.000Z",
          completedAt: "2001-01-01T00:02:00.000Z",
          decisionId: "decision-1",
          continuationId: "continuation-1",
          turnId: "turn-1",
          coachText: "We’ll keep tomorrow easy.",
        },
      ],
      nextCursor: null,
    }));

    await hydrator.start();
    const snapshot = snapshots.at(-1)!;
    expect(snapshot.entries).toHaveLength(3);
    expect(mergeHydratedMessages(snapshot.turns, [], snapshot.entries)).toMatchObject([
      { role: "athlete", text: "What should I do tomorrow?", historical: true },
      { role: "coach", text: "We’ll keep tomorrow easy.", historical: true },
    ]);
  });

  it("loads the newest bounded page and exposes only its backward cursor", async () => {
    const readPage = vi.fn(async () => page([turn("turn-3"), turn("turn-4")], "older"));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();

    expect(readPage).toHaveBeenCalledWith({
      cursor: null,
      limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
    });
    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [{ turnId: "turn-3" }, { turnId: "turn-4" }],
      nextCursor: "older",
      revision: 1,
      change: "initial",
    });
  });

  it("prepends one explicit page at a time without replacing stable newer turns", async () => {
    const newest = [turn("turn-3"), turn("turn-4")];
    const earlier = [turn("turn-1"), turn("turn-2")];
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page(newest, "older"))
      .mockResolvedValueOnce(page(earlier, null));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    const newerReferences = snapshots.at(-1)!.turns;
    await hydrator.loadEarlier();

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0]).toEqual({
      cursor: "older",
      limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
    });
    expect(snapshots.at(-1)?.turns.map(({ turnId }) => turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
      "turn-4",
    ]);
    expect(snapshots.at(-1)?.turns[2]).toBe(newerReferences[0]);
    expect(snapshots.at(-1)?.turns[3]).toBe(newerReferences[1]);
    expect(snapshots.at(-1)).toMatchObject({ nextCursor: null, change: "prepend" });
  });

  it("deduplicates a hydrated turn against live rows by turn identity", () => {
    const live: readonly ChatTranscriptMessage[] = [
      {
        id: "message-1",
        turnId: "turn-2",
        role: "athlete",
        text: "Live athlete",
        delivery: "complete",
      },
      {
        id: "message-2",
        turnId: "turn-2",
        role: "coach",
        text: "Live coach",
        delivery: "complete",
      },
    ];

    const merged = mergeHydratedMessages([turn("turn-1"), turn("turn-2")], live);

    expect(merged.map(({ id }) => id)).toEqual([
      "history:athlete:turn-1",
      "history:coach:turn-1",
      "message-1",
      "message-2",
    ]);
    expect(merged.slice(2)).toEqual(live);
  });

  it("restores an interrupted coach response after relaunch", () => {
    const interrupted = { ...turn("turn-stopped"), delivery: "interrupted" as const };

    expect(mergeHydratedMessages([interrupted], [])).toEqual([
      {
        id: "history:athlete:turn-stopped",
        turnId: "turn-stopped",
        role: "athlete",
        text: "Athlete turn-stopped",
        delivery: "complete",
        historical: true,
      },
      {
        id: "history:coach:turn-stopped",
        turnId: "turn-stopped",
        role: "coach",
        text: "Coach turn-stopped",
        delivery: "interrupted",
        historical: true,
      },
    ]);
  });

  it("clears stale history and restarts from newest once after a reset signal", async () => {
    const recovery = deferred<TranscriptPage>();
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([turn("turn-3"), turn("turn-4")], "older"))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        status: "restart-required",
        turns: [],
        nextCursor: null,
      })
      .mockImplementationOnce(() => recovery.promise);
    const { hydrator, snapshots } = subject(readPage);
    await hydrator.start();

    const loading = hydrator.loadEarlier();
    await vi.waitFor(() => {
      expect(snapshots.at(-1)).toMatchObject({
        turns: [],
        status: "loading",
        change: "clear",
      });
    });
    expect(readPage).toHaveBeenCalledTimes(3);
    expect(readPage.mock.calls[2]?.[0]).toMatchObject({ cursor: null });

    recovery.resolve(page([turn("turn-8")], null));
    await loading;

    expect(snapshots.at(-1)).toMatchObject({
      turns: [{ turnId: "turn-8" }],
      status: "ready",
      change: "initial",
    });
  });

  it("does not loop when the one newest-page recovery also requests a restart", async () => {
    const restart: TranscriptPage = {
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    };
    const readPage = vi.fn(async () => restart);
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({ status: "failed", turns: [] });
  });

  it("retries the newest page after reset recovery fails", async () => {
    const restart: TranscriptPage = {
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce(page([turn("turn-2")], "older"))
      .mockResolvedValueOnce(restart)
      .mockRejectedValueOnce(new Error("internal detail"))
      .mockResolvedValueOnce(page([turn("turn-8")], null));
    const { hydrator, snapshots } = subject(readPage);
    await hydrator.start();

    await hydrator.loadEarlier();
    expect(snapshots.at(-1)).toMatchObject({ status: "failed", turns: [] });

    await hydrator.retry();

    expect(readPage.mock.calls[3]?.[0]).toMatchObject({ cursor: null });
    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [{ turnId: "turn-8" }],
    });
  });

  it("ignores an in-flight page after a successful new-conversation reset", async () => {
    const pending = deferred<TranscriptPage>();
    const { hydrator, snapshots } = subject(() => pending.promise);
    const loading = hydrator.start();

    hydrator.beginReset();
    hydrator.resetSucceeded();
    pending.resolve(page([turn("turn-stale")], null));
    await loading;

    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [],
      change: "clear",
    });
    expect(snapshots.some((snapshot) => snapshot.turns[0]?.turnId === "turn-stale")).toBe(false);
  });

  it("keeps failures non-fatal and retries only the failed page", async () => {
    const readPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("internal detail"))
      .mockResolvedValueOnce(page([turn("turn-1")], null));
    const { hydrator, snapshots } = subject(readPage);

    await hydrator.start();
    expect(snapshots.at(-1)).toMatchObject({ status: "failed", turns: [] });

    await hydrator.retry();

    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0]).toMatchObject({ cursor: null });
    expect(snapshots.at(-1)).toMatchObject({
      status: "ready",
      turns: [{ turnId: "turn-1" }],
    });
  });
});
