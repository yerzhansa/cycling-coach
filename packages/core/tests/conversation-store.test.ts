import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveAndResetDurably,
  ChatStore,
  createChatStoreWithHooks,
} from "../src/agent/chat-store.js";
import { ConversationRecoveryError, ConversationStore } from "../src/agent/conversation-store.js";
import { TranscriptStore, type ResetIntentRecord } from "../src/agent/transcript-store.js";

const roots: string[] = [];
const RESET_ID = "c".repeat(64);

function makeDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "conversation-store-"));
  roots.push(path);
  return path;
}

function transcriptPath(dataDir: string, chatId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(dataDir, "transcripts", `${digest}.jsonl`);
}

function intentPath(dataDir: string, chatId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(dataDir, "transcripts", `${digest}.reset-intent.json`);
}

function intentTempPath(dataDir: string, chatId: string, resetId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(dataDir, "transcripts", `${digest}.${resetId}.reset-intent.tmp`);
}

function resetIntent(chatId: string, resetId = RESET_ID): ResetIntentRecord {
  return {
    version: 1,
    kind: "conversation-reset-intent",
    resetId,
    chatId,
    boundaryAt: "2026-07-22T01:02:03.000Z",
    reason: "explicit-reset",
  };
}

const LINEAGE = {
  templateHash: "template",
  assembledHash: "assembled",
  provider: "synthetic",
  model: "synthetic",
  lineageVersion: "1",
};

function seedSession(store: ChatStore, chatId: string): void {
  store.appendTurn(chatId, "athlete", "coach", LINEAGE);
}

function resetArchives(dataDir: string, chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((name) =>
    name.startsWith(`${chatId}.jsonl.reset.`),
  );
}

function resetArchivePath(dataDir: string, reset: ResetIntentRecord): string {
  return join(
    dataDir,
    "sessions",
    `${reset.chatId}.jsonl.reset.${reset.boundaryAt.replace(/:/g, "-")}.${reset.resetId}`,
  );
}

function boundaryCount(dataDir: string, chatId: string, resetId = RESET_ID): number {
  const path = transcriptPath(dataDir, chatId);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      if (line.length === 0) return false;
      try {
        const value = JSON.parse(line) as { kind?: string; resetId?: string };
        return value.kind === "conversation-boundary" && value.resetId === resetId;
      } catch {
        return false;
      }
    }).length;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ConversationStore reset transaction recovery", () => {
  it("keeps transcript pagination read-only when a reset intent is pending", () => {
    const dataDir = makeDataDir();
    const chatId = "read-only-page";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    const pending = resetIntent(chatId);
    transcript.createResetIntent(pending);
    const before = readFileSync(transcriptPath(dataDir, chatId));

    const page = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });

    expect(page.turns.map((turn) => turn.turnId)).toEqual(["turn-1"]);
    expect(transcript.readResetIntent(chatId)).toEqual(pending);
    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
    expect(boundaryCount(dataDir, chatId)).toBe(0);
  });

  it("surfaces the pre-reset conversation as an archived read after a completed reset", () => {
    const dataDir = makeDataDir();
    const chatId = "archived-after-reset";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-2",
      completedAt: "2026-07-22T00:00:01.000Z",
      athleteText: "c",
      coachText: "d",
    });

    store.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-3",
      completedAt: "2026-07-22T02:00:00.000Z",
      athleteText: "e",
      coachText: "f",
    });
    const before = readFileSync(transcriptPath(dataDir, chatId));

    expect(store.listArchivedConversations(chatId)).toEqual({
      schemaVersion: 1,
      conversations: [
        {
          boundaryRef: RESET_ID,
          boundaryAt: "2026-07-22T01:02:03.000Z",
          reason: "explicit-reset",
          turnCount: 2,
        },
      ],
      truncated: false,
    });
    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID, { cursor: null, limit: 25 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-1", "turn-2"]);
    expect(
      store
        .readCurrentConversationPage(chatId, { cursor: null, limit: 25 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-3"]);
    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
  });

  it("fences a pagination cursor after the reset transaction completes", () => {
    const dataDir = makeDataDir();
    const chatId = "completed-reset-page";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-2",
      completedAt: "2026-07-22T00:00:01.000Z",
      athleteText: "c",
      coachText: "d",
    });
    const page = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });

    store.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });

    expect(
      store.readCurrentConversationPage(chatId, {
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    });
  });

  it("recovers intent-only by ensuring one boundary and archiving the active session", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("intent-only");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);

    const recovered = new ConversationStore(chat, transcript);

    expect(recovered.hasSession(reset.chatId)).toBe(false);
    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it("recovers intent plus a torn boundary without changing torn bytes", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("torn-boundary");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.appendCompletedTurn({
      chatId: reset.chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "old athlete",
      coachText: "old coach",
    });
    appendFileSync(transcriptPath(dataDir, reset.chatId), '{"version":1,"kind":"conversation');
    const torn = readFileSync(transcriptPath(dataDir, reset.chatId));

    const recovered = new ConversationStore(chat, transcript);

    expect(recovered.hasSession(reset.chatId)).toBe(false);
    expect(readFileSync(transcriptPath(dataDir, reset.chatId)).subarray(0, torn.length)).toEqual(
      torn,
    );
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("recovers a durable boundary with an active session without duplicating the boundary", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("boundary-active");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.ensureConversationBoundary(reset);

    new ConversationStore(chat, transcript);

    expect(chat.hasSession(reset.chatId)).toBe(false);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it("removes a surviving intent after an already-completed archive without a second archive", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("archived-intent");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.ensureConversationBoundary(reset);
    archiveAndResetDurably(chat, reset.chatId, reset);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);

    new ConversationStore(chat, transcript);

    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("recovers the archive hardlink window without creating another archive", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("archive-link-window");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.ensureConversationBoundary(reset);
    const active = join(dataDir, "sessions", `${reset.chatId}.jsonl`);
    const archive = resetArchivePath(dataDir, reset);
    linkSync(active, archive);
    expect(lstatSync(active).nlink).toBe(2);

    new ConversationStore(chat, transcript);

    expect(existsSync(active)).toBe(false);
    expect(lstatSync(archive).nlink).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("replays the same completed intent idempotently after recovery", () => {
    const dataDir = makeDataDir();
    const chatId = "replay";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const first = new ConversationStore(chat, transcript, () => RESET_ID);
    seedSession(chat, chatId);
    first.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });
    const completed = resetIntent(chatId);
    transcript.createResetIntent(completed);

    new ConversationStore(chat, transcript);
    new ConversationStore(chat, transcript);

    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(transcript.readResetIntent(chatId)).toBeNull();
  });

  it("reconciles the hardlink publication window before construction recovery", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("linked-intent-window");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    const target = intentPath(dataDir, reset.chatId);
    const temp = intentTempPath(dataDir, reset.chatId, reset.resetId);
    linkSync(target, temp);
    expect(lstatSync(target).nlink).toBe(2);

    new ConversationStore(chat, transcript);

    expect(existsSync(temp)).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it("removes a partial orphan temp from a crash before intent publication", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("orphan-temp");
    seedSession(chat, reset.chatId);
    const temp = intentTempPath(dataDir, reset.chatId, reset.resetId);
    writeFileSync(temp, '{"version":1', { mode: 0o600 });

    const recovered = new ConversationStore(chat, transcript);

    expect(existsSync(temp)).toBe(false);
    expect(recovered.hasSession(reset.chatId)).toBe(true);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(0);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(0);
  });

  it("cleans a proven zero-byte boundary failure and leaves the active session usable", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const chatId = "safe-cleanup";
    seedSession(chat, chatId);
    new TranscriptStore(dataDir).appendCompletedTurn({
      chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    let writes = 0;
    const transcript = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        if (writes === 2) return 0;
        return writeSync(descriptor, buffer, offset, length, position);
      },
    });
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("Transcript append was incomplete.");
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(0);
    expect(resetArchives(dataDir, chatId)).toHaveLength(0);
    expect(store.load(chatId).messages).toHaveLength(2);
  });

  it("retains a one-shot short boundary write and recovers through one valid boundary", () => {
    const dataDir = makeDataDir();
    const chatId = "short-boundary-recovery";
    const chat = new ChatStore(dataDir);
    seedSession(chat, chatId);
    new TranscriptStore(dataDir).appendCompletedTurn({
      chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    let writes = 0;
    const transcript = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        const bytes = writes === 2 ? Math.floor(length / 2) : length;
        return writeSync(descriptor, buffer, offset, bytes, position);
      },
    });
    const removeIntent = vi.spyOn(transcript, "removeResetIntent");
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("Transcript append was incomplete.");
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(0);
    expect(new TranscriptStore(dataDir).readCurrentConversation(chatId)).toEqual([]);
    expect(removeIntent).not.toHaveBeenCalled();

    expect(store.load(chatId).messages).toEqual([]);

    expect(chat.hasSession(chatId)).toBe(false);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(transcript.readCurrentConversation(chatId)).toEqual([]);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(removeIntent).toHaveBeenCalledTimes(1);
  });

  it("keeps a repeatedly short boundary failure blocked without trusting an old turn", () => {
    const dataDir = makeDataDir();
    const chatId = "repeated-short-boundary";
    const chat = new ChatStore(dataDir);
    seedSession(chat, chatId);
    new TranscriptStore(dataDir).appendCompletedTurn({
      chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    let writes = 0;
    const transcript = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        const bytes = writes === 1 ? length : Math.floor(length / 2);
        return writeSync(descriptor, buffer, offset, bytes, position);
      },
    });
    const removeIntent = vi.spyOn(transcript, "removeResetIntent");
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("Transcript append was incomplete.");
    expect(() => store.load(chatId)).toThrow(ConversationRecoveryError);

    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(0);
    expect(new TranscriptStore(dataDir).readCurrentConversation(chatId)).toEqual([]);
    expect(removeIntent).not.toHaveBeenCalled();
  });

  it("retains a valid boundary intent after archive failure and finishes before later access", () => {
    const dataDir = makeDataDir();
    let fileSyncs = 0;
    const chat = createChatStoreWithHooks(dataDir, 0, {
      syncFile: (descriptor) => {
        fileSyncs += 1;
        if (fileSyncs === 1) throw new Error("synthetic archive failure");
        fsyncSync(descriptor);
      },
    });
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    const chatId = "archive-failure";
    seedSession(chat, chatId);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("synthetic archive failure");
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);

    expect(store.load(chatId).messages).toEqual([]);
    expect(chat.hasSession(chatId)).toBe(false);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(fileSyncs).toBe(2);
  });

  it("never cleans an intent when a valid but duplicate reset boundary is present", () => {
    const dataDir = makeDataDir();
    const chatId = "duplicate-boundary";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent(chatId);
    transcript.ensureConversationBoundary(reset);
    appendFileSync(transcriptPath(dataDir, chatId), readFileSync(transcriptPath(dataDir, chatId)));
    seedSession(chat, chatId);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: reset.boundaryAt,
        reason: reset.reason,
      }),
    ).toThrow("Transcript contains duplicate reset boundaries.");
    expect(transcript.readResetIntent(chatId)).toEqual(reset);
    expect(chat.hasSession(chatId)).toBe(true);
    expect(() => store.load(chatId)).toThrow(ConversationRecoveryError);
    expect(boundaryCount(dataDir, chatId)).toBe(2);
  });

  it("treats a full append followed by fsync failure as a retained valid boundary", () => {
    const dataDir = makeDataDir();
    let fileSyncs = 0;
    const transcript = new TranscriptStore(dataDir, {
      syncFile: (descriptor) => {
        fileSyncs += 1;
        if (fileSyncs === 2) throw new Error("synthetic boundary fsync failure");
        fsyncSync(descriptor);
      },
    });
    const chat = new ChatStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    const chatId = "boundary-sync-failure";
    seedSession(chat, chatId);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("synthetic boundary fsync failure");
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);

    expect(store.readCurrentConversation(chatId)).toEqual([]);
    expect(chat.hasSession(chatId)).toBe(false);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(fileSyncs).toBe(3);
  });

  it("retries boundary directory fsync before removing a retained intent", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    let directorySyncs = 0;
    const transcript = new TranscriptStore(dataDir, {
      syncDirectory: (descriptor) => {
        directorySyncs += 1;
        if (directorySyncs === 3) {
          throw new Error("synthetic boundary directory sync failure");
        }
        fsyncSync(descriptor);
      },
    });
    const originalRemove = transcript.removeResetIntent.bind(transcript);
    let directorySyncsAtRemoval = 0;
    vi.spyOn(transcript, "removeResetIntent").mockImplementation((reset) => {
      directorySyncsAtRemoval = directorySyncs;
      originalRemove(reset);
    });
    const chat = new ChatStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    const chatId = "boundary-directory-sync-failure";
    seedSession(chat, chatId);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("synthetic boundary directory sync failure");
    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(directorySyncs).toBe(3);

    expect(store.load(chatId).messages).toEqual([]);

    expect(directorySyncsAtRemoval).toBe(4);
    expect(directorySyncs).toBe(5);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(chat.hasSession(chatId)).toBe(false);
  });

  it("retries the sessions directory fsync after unlink before removing the intent", () => {
    const dataDir = makeDataDir();
    let directorySyncs = 0;
    const chat = createChatStoreWithHooks(dataDir, 0, {
      syncDirectory: (descriptor) => {
        directorySyncs += 1;
        if (directorySyncs === 2) {
          throw new Error("synthetic post-unlink directory sync failure");
        }
        fsyncSync(descriptor);
      },
    });
    const transcript = new TranscriptStore(dataDir);
    const originalRemove = transcript.removeResetIntent.bind(transcript);
    let sessionsSyncsAtRemoval = 0;
    vi.spyOn(transcript, "removeResetIntent").mockImplementation((reset) => {
      sessionsSyncsAtRemoval = directorySyncs;
      originalRemove(reset);
    });
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    const chatId = "session-directory-retry";
    seedSession(chat, chatId);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("synthetic post-unlink directory sync failure");
    expect(chat.hasSession(chatId)).toBe(false);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(directorySyncs).toBe(2);

    expect(store.load(chatId).messages).toEqual([]);

    expect(sessionsSyncsAtRemoval).toBe(3);
    expect(directorySyncs).toBe(3);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
  });

  it("keeps completed-turn transcript bytes stable across ChatStore compaction mutations", () => {
    const dataDir = makeDataDir();
    const chatId = "compaction-boundary";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:01.000Z",
      athleteText: "synthetic athlete one",
      coachText: "synthetic coach one",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-2",
      completedAt: "2026-07-22T00:00:02.000Z",
      athleteText: "synthetic athlete two",
      coachText: "synthetic coach two",
    });
    store.appendTurn(chatId, "synthetic user", "synthetic assistant", LINEAGE);
    const before = readFileSync(transcriptPath(dataDir, chatId));

    store.archivePreCompact(chatId);
    store.overwriteHistory(chatId, [{ role: "assistant", content: "synthetic compacted" }]);

    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("blocks load, completed-turn append, and transcript read while recovery cannot finish", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("blocked");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    vi.spyOn(transcript, "ensureConversationBoundary").mockImplementation(() => {
      throw new Error("synthetic persistent recovery failure");
    });
    const store = new ConversationStore(chat, transcript);

    expect(() => store.load(reset.chatId)).toThrow(ConversationRecoveryError);
    expect(() =>
      store.appendCompletedTurn({
        chatId: reset.chatId,
        turnId: "blocked-turn",
        completedAt: "2026-07-22T02:00:00.000Z",
        athleteText: "athlete",
        coachText: "coach",
      }),
    ).toThrow(ConversationRecoveryError);
    expect(() => store.readCurrentConversation(reset.chatId)).toThrow(ConversationRecoveryError);
    expect(chat.hasSession(reset.chatId)).toBe(true);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(0);
  });
});
