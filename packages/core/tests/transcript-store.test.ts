import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TRANSCRIPT_RECORD_BYTES,
  TranscriptRecordTooLargeError,
  TranscriptStore,
  UnsafeTranscriptTargetError,
  type ResetIntentRecord,
} from "../src/agent/transcript-store.js";

const roots: string[] = [];
const RESET_ID_A = "a".repeat(64);
const RESET_ID_B = "b".repeat(64);

function makeDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "transcript-store-"));
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

function turn(chatId: string, turnId: string, athleteText = "athlete", coachText = "coach") {
  return {
    chatId,
    turnId,
    completedAt: `2026-07-22T00:00:0${turnId.at(-1) ?? "0"}.000Z`,
    athleteText,
    coachText,
  };
}

function serializedTurn(input: ReturnType<typeof turn>): Buffer {
  return Buffer.from(
    `${JSON.stringify({ version: 1, kind: "turn-completed", ...input })}\n`,
    "utf8",
  );
}

function turnWithSerializedBytes(
  targetBytes: number,
  chatId = "record-size",
): ReturnType<typeof turn> {
  const input = turn(chatId, "turn-1", '🚴\n"\\', "synthetic coach");
  const paddingBytes = targetBytes - serializedTurn(input).length;
  if (paddingBytes < 0) throw new RangeError("Target record size is too small.");
  return { ...input, athleteText: `${input.athleteText}${"x".repeat(paddingBytes)}` };
}

function intent(
  chatId: string,
  resetId = RESET_ID_A,
  reason: ResetIntentRecord["reason"] = "explicit-reset",
): ResetIntentRecord {
  return {
    version: 1,
    kind: "conversation-reset-intent",
    resetId,
    chatId,
    boundaryAt: "2026-07-22T01:00:00.000Z",
    reason,
  };
}

function corruptionCases(chatId: string): readonly (readonly [string, Buffer])[] {
  return [
    ["invalid JSON", Buffer.from("not-json\n")],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["empty unexpected line", Buffer.from("\n")],
    ["unknown version", Buffer.from('{"version":2,"kind":"turn-completed"}\n')],
    ["unknown kind", Buffer.from('{"version":1,"kind":"future-record"}\n')],
    [
      "non-strict schema",
      Buffer.from(
        `${JSON.stringify({ version: 1, kind: "turn-completed", ...turn(chatId, "turn-x"), extra: true })}\n`,
      ),
    ],
    [
      "wrong-chat record",
      Buffer.from(
        `${JSON.stringify({ version: 1, kind: "turn-completed", ...turn("other", "turn-x") })}\n`,
      ),
    ],
    [
      "boundary without resetId",
      Buffer.from(
        `${JSON.stringify({
          version: 1,
          kind: "conversation-boundary",
          chatId,
          boundaryAt: "2026-07-22T01:00:00.000Z",
          reason: "explicit-reset",
        })}\n`,
      ),
    ],
    ["unterminated EOF", Buffer.from('{"version":1,"kind":"turn-completed"')],
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TranscriptStore append and corruption handling", () => {
  it("returns an empty conversation for a missing transcript without creating its file", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const path = transcriptPath(dataDir, "missing");

    expect(store.readCurrentConversation("missing")).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips exact Unicode and whitespace in one strict newline-terminated record", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = turn(
      "chat-unicode",
      "turn-1",
      "  🚴🏽‍♀️\n\tПривет\r\n尾部  ",
      "\n  Café\u00a0coach\t🏁\n",
    );

    store.appendCompletedTurn(input);

    const raw = readFileSync(transcriptPath(dataDir, input.chatId), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n")).toHaveLength(2);
    expect(JSON.parse(raw.trimEnd())).toEqual({
      version: 1,
      kind: "turn-completed",
      ...input,
    });
    expect(store.readCurrentConversation(input.chatId)).toEqual([
      { version: 1, kind: "turn-completed", ...input },
    ]);
  });

  it("preserves append order across a fresh store instance", () => {
    const dataDir = makeDataDir();
    const first = new TranscriptStore(dataDir);
    first.appendCompletedTurn(turn("ordered", "turn-1"));
    first.appendCompletedTurn(turn("ordered", "turn-2"));

    const reopened = new TranscriptStore(dataDir);
    expect(reopened.readCurrentConversation("ordered").map((record) => record.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("accepts an exact 262,144-byte serialized Unicode and escaped record", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = turnWithSerializedBytes(MAX_TRANSCRIPT_RECORD_BYTES);
    const bytes = serializedTurn(input);

    expect(bytes).toHaveLength(MAX_TRANSCRIPT_RECORD_BYTES);
    expect(bytes.toString("utf8").length).toBeLessThan(MAX_TRANSCRIPT_RECORD_BYTES);

    store.appendCompletedTurn(input);

    expect(readFileSync(transcriptPath(dataDir, input.chatId))).toEqual(bytes);
  });

  it("rejects an exact 262,145-byte record before target access or mutation", () => {
    const dataDir = makeDataDir();
    let existingFileOpens = 0;
    const store = new TranscriptStore(dataDir, {
      beforeExistingFileOpen: () => {
        existingFileOpens += 1;
      },
    });
    const freshInput = turnWithSerializedBytes(MAX_TRANSCRIPT_RECORD_BYTES + 1);
    const freshPath = transcriptPath(dataDir, freshInput.chatId);
    const existingChatId = "existing-record-size";

    expect(serializedTurn(freshInput)).toHaveLength(MAX_TRANSCRIPT_RECORD_BYTES + 1);
    expect(serializedTurn(freshInput).toString("utf8").length).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_RECORD_BYTES,
    );
    expect(() => store.appendCompletedTurn(freshInput)).toThrowError(
      expect.objectContaining({ code: "TRANSCRIPT_RECORD_TOO_LARGE" }),
    );
    expect(existsSync(freshPath)).toBe(false);

    store.appendCompletedTurn(turn(existingChatId, "turn-1"));
    const existingPath = transcriptPath(dataDir, existingChatId);
    const prefix = readFileSync(existingPath);
    const oversizedExisting = turnWithSerializedBytes(
      MAX_TRANSCRIPT_RECORD_BYTES + 1,
      existingChatId,
    );

    expect(() => store.appendCompletedTurn(oversizedExisting)).toThrow(
      TranscriptRecordTooLargeError,
    );
    expect(existingFileOpens).toBe(0);
    expect(readFileSync(existingPath)).toEqual(prefix);
  });

  it("hashes malicious chat IDs without creating paths outside the transcript directory", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const chatIds = ["../../escape", "/tmp/absolute", "..\\..\\windows", "nested/id"];

    for (const [index, chatId] of chatIds.entries()) {
      store.appendCompletedTurn(turn(chatId, `turn-${index + 1}`));
    }

    const names = readdirSync(join(dataDir, "transcripts"));
    expect(names).toHaveLength(chatIds.length);
    expect(names.every((name) => /^[a-f0-9]{64}\.jsonl$/.test(name))).toBe(true);
    expect(readdirSync(dataDir).sort()).toEqual(["transcripts"]);
  });

  it.each(corruptionCases("strict"))(
    "fails closed after %s and ignores later turns until a boundary",
    (_name, corrupt) => {
      const dataDir = makeDataDir();
      const chatId = "strict";
      const store = new TranscriptStore(dataDir);
      const path = transcriptPath(dataDir, chatId);
      store.appendCompletedTurn(turn(chatId, "turn-1"));
      appendFileSync(path, corrupt);
      const throughCorruption = readFileSync(path);
      store.appendCompletedTurn(turn(chatId, "turn-2"));

      expect(store.readCurrentConversation(chatId)).toEqual([]);
      expect(readFileSync(path).subarray(0, throughCorruption.length)).toEqual(throughCorruption);
    },
  );

  it.each(corruptionCases("recover-trust"))(
    "restores trust only at a fully valid same-chat boundary after %s",
    (_name, corrupt) => {
      const dataDir = makeDataDir();
      const chatId = "recover-trust";
      const store = new TranscriptStore(dataDir);
      const path = transcriptPath(dataDir, chatId);
      store.appendCompletedTurn(turn(chatId, "turn-1"));
      appendFileSync(path, corrupt);
      store.appendCompletedTurn(turn(chatId, "turn-2"));
      expect(store.readCurrentConversation(chatId)).toEqual([]);

      store.ensureConversationBoundary(intent(chatId));
      store.appendCompletedTurn(turn(chatId, "turn-3"));

      expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
        "turn-3",
      ]);
    },
  );

  it("treats an injected oversize JSONL line as corruption until a later boundary", () => {
    const dataDir = makeDataDir();
    const chatId = "oversize-corruption";
    const path = transcriptPath(dataDir, chatId);
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    const injected = serializedTurn(
      turnWithSerializedBytes(MAX_TRANSCRIPT_RECORD_BYTES + 1, chatId),
    );
    appendFileSync(path, injected);
    const throughInjectedLine = readFileSync(path);

    store.appendCompletedTurn(turn(chatId, "turn-2"));
    expect(store.readCurrentConversation(chatId)).toEqual([]);

    store.ensureConversationBoundary(intent(chatId));
    store.appendCompletedTurn(turn(chatId, "turn-3"));

    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-3",
    ]);
    expect(readFileSync(path).subarray(0, throughInjectedLine.length)).toEqual(throughInjectedLine);
  });

  it("keeps torn bytes unchanged and recovers through a later durable boundary", () => {
    const dataDir = makeDataDir();
    const chatId = "torn";
    const path = transcriptPath(dataDir, chatId);
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    appendFileSync(path, '{"version":1,"kind":"conversation-boundary"');
    const tornBytes = readFileSync(path);

    store.appendCompletedTurn(turn(chatId, "turn-9"));
    expect(store.readCurrentConversation(chatId)).toEqual([]);
    store.ensureConversationBoundary(intent(chatId));
    store.appendCompletedTurn(turn(chatId, "turn-2"));

    expect(readFileSync(path).subarray(0, tornBytes.length)).toEqual(tornBytes);
    const beforeRead = readFileSync(path);
    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-2",
    ]);
    expect(readFileSync(path)).toEqual(beforeRead);
  });

  it("ensures one resetId boundary idempotently", () => {
    const dataDir = makeDataDir();
    const chatId = "boundaries";
    const store = new TranscriptStore(dataDir);
    const reset = intent(chatId);
    store.ensureConversationBoundary(reset);
    store.ensureConversationBoundary(reset);
    store.appendCompletedTurn(turn(chatId, "turn-1"));

    const records = readFileSync(transcriptPath(dataDir, chatId), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; resetId?: string });
    expect(records.filter((record) => record.kind === "conversation-boundary")).toEqual([
      expect.objectContaining({ resetId: RESET_ID_A }),
    ]);
    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-1",
    ]);
  });

  it("uses one newline-terminated write and syncs a new file before its directory entry", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    const writes: Buffer[] = [];
    const syncOrder: string[] = [];
    const store = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes.push(Buffer.from(buffer as Uint8Array).subarray(offset, offset + length));
        return writeSync(descriptor, buffer, offset, length, position);
      },
      syncFile: (descriptor) => {
        syncOrder.push("file");
        fsyncSync(descriptor);
      },
      syncDirectory: (descriptor) => {
        syncOrder.push("directory");
        fsyncSync(descriptor);
      },
    });

    store.appendCompletedTurn(turn("durable", "turn-1", "embedded\nnewline"));

    expect(writes).toHaveLength(1);
    expect([...writes[0]!].filter((byte) => byte === 0x0a)).toHaveLength(1);
    expect(syncOrder).toEqual(["file", "directory"]);
  });

  it("preserves every prior byte across normal appends and reads", () => {
    const dataDir = makeDataDir();
    const chatId = "append-only";
    const path = transcriptPath(dataDir, chatId);
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    const beforeAppend = readFileSync(path);

    store.appendCompletedTurn(turn(chatId, "turn-2"));

    const afterAppend = readFileSync(path);
    expect(afterAppend.subarray(0, beforeAppend.length)).toEqual(beforeAppend);
    store.readCurrentConversation(chatId);
    expect(readFileSync(path)).toEqual(afterAppend);
  });

  it("detects a short single-call write and leaves the torn bytes in place", () => {
    const dataDir = makeDataDir();
    let writes = 0;
    const store = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        return writeSync(descriptor, buffer, offset, Math.floor(length / 2), position);
      },
    });

    expect(() => store.appendCompletedTurn(turn("short-write", "turn-1"))).toThrow(
      "Transcript append was incomplete.",
    );
    expect(writes).toBe(1);
    const raw = readFileSync(transcriptPath(dataDir, "short-write"));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[raw.length - 1]).not.toBe(0x0a);
    expect(store.readCurrentConversation("short-write")).toEqual([]);
  });

  it("propagates file fsync failure after issuing the complete append", () => {
    const dataDir = makeDataDir();
    const failure = new Error("synthetic file sync failure");
    const store = new TranscriptStore(dataDir, {
      syncFile: () => {
        throw failure;
      },
    });

    expect(() => store.appendCompletedTurn(turn("sync-failure", "turn-1"))).toThrow(failure);
    const raw = readFileSync(transcriptPath(dataDir, "sync-failure"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({ kind: "turn-completed", turnId: "turn-1" }),
    );
  });

  it("propagates transcript directory fsync failure after syncing a new file", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    const failure = new Error("synthetic directory sync failure");
    const store = new TranscriptStore(dataDir, {
      syncDirectory: () => {
        throw failure;
      },
    });

    expect(() => store.appendCompletedTurn(turn("directory-sync", "turn-1"))).toThrow(failure);
    const raw = readFileSync(transcriptPath(dataDir, "directory-sync"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({ kind: "turn-completed", turnId: "turn-1" }),
    );
  });

  it("retries transcript directory durability on a later append", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    let directorySyncs = 0;
    const store = new TranscriptStore(dataDir, {
      syncDirectory: (descriptor) => {
        directorySyncs += 1;
        if (directorySyncs === 1) throw new Error("synthetic first directory sync failure");
        fsyncSync(descriptor);
      },
    });

    expect(() => store.appendCompletedTurn(turn("directory-retry", "turn-1"))).toThrow(
      "synthetic first directory sync failure",
    );
    store.appendCompletedTurn(turn("directory-retry", "turn-2"));

    expect(directorySyncs).toBe(2);
    expect(store.readCurrentConversation("directory-retry").map((record) => record.turnId)).toEqual(
      ["turn-1", "turn-2"],
    );
  });

  it("fails an append when its pathname is replaced during the write", () => {
    const dataDir = makeDataDir();
    const chatId = "write-path-replacement";
    const path = transcriptPath(dataDir, chatId);
    const originalPath = `${path}.original`;
    new TranscriptStore(dataDir).appendCompletedTurn(turn(chatId, "turn-1"));
    let replaced = false;
    const store = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        if (!replaced) {
          replaced = true;
          renameSync(path, originalPath);
          writeFileSync(path, "synthetic replacement\n", { mode: 0o600 });
        }
        return writeSync(descriptor, buffer, offset, length, position);
      },
    });

    expect(() => store.appendCompletedTurn(turn(chatId, "turn-2"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(readFileSync(path, "utf8")).toBe("synthetic replacement\n");
    expect(readFileSync(path, "utf8")).not.toContain("turn-2");
    expect(readFileSync(originalPath, "utf8")).toContain('"turnId":"turn-2"');
  });
});

describe("TranscriptStore private race-checked targets", () => {
  it("creates exact 0700/0600 storage and strict owner-only reset intents", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn("mode", "turn-1"));
    store.createResetIntent(intent("intent-mode"));

    expect(lstatSync(join(dataDir, "transcripts")).mode & 0o7777).toBe(0o700);
    expect(lstatSync(transcriptPath(dataDir, "mode")).mode & 0o7777).toBe(0o600);
    const intentStats = lstatSync(intentPath(dataDir, "intent-mode"));
    expect(intentStats.mode & 0o7777).toBe(0o600);
    expect(intentStats.nlink).toBe(1);
    expect(store.readResetIntent("intent-mode")).toEqual(intent("intent-mode"));
    expect(JSON.parse(readFileSync(intentPath(dataDir, "intent-mode"), "utf8"))).toEqual(
      intent("intent-mode"),
    );
  });

  it("rejects a non-strict or wrong-version reset intent", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("invalid-intent");
    writeFileSync(
      intentPath(dataDir, reset.chatId),
      `${JSON.stringify({ ...reset, version: 2, extra: true })}\n`,
      { mode: 0o600 },
    );

    expect(() => store.readResetIntent(reset.chatId)).toThrow(UnsafeTranscriptTargetError);
    expect(() => store.listResetIntents()).toThrow(UnsafeTranscriptTargetError);
  });

  it("refuses permissive existing targets without chmodding them", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const path = transcriptPath(dataDir, "permissions");
    writeFileSync(path, "outside\n", { mode: 0o644 });
    chmodSync(path, 0o644);

    expect(() => store.appendCompletedTurn(turn("permissions", "turn-1"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(() => store.readCurrentConversation("permissions")).toThrow(UnsafeTranscriptTargetError);
    expect(lstatSync(path).mode & 0o7777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe("outside\n");
  });

  it("refuses symlink, hardlink, and non-regular transcript targets", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const outside = join(dataDir, "outside.jsonl");
    writeFileSync(outside, "outside\n", { mode: 0o600 });

    symlinkSync(outside, transcriptPath(dataDir, "linked"));
    linkSync(outside, transcriptPath(dataDir, "hardlinked"));
    mkdirSync(transcriptPath(dataDir, "directory"), { mode: 0o600 });

    for (const chatId of ["linked", "hardlinked", "directory"]) {
      expect(() => store.appendCompletedTurn(turn(chatId, "turn-1"))).toThrow(
        UnsafeTranscriptTargetError,
      );
      expect(() => store.readCurrentConversation(chatId)).toThrow(UnsafeTranscriptTargetError);
    }
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(lstatSync(outside).mode & 0o7777).toBe(0o600);
    expect(lstatSync(outside).nlink).toBe(2);
  });

  it("detects a target identity substitution between lstat and open", () => {
    const dataDir = makeDataDir();
    const path = transcriptPath(dataDir, "swap-file");
    let swapped = false;
    const store = new TranscriptStore(dataDir, {
      beforeExistingFileOpen: (openedPath) => {
        if (openedPath !== path || swapped) return;
        swapped = true;
        renameSync(path, `${path}.original`);
        writeFileSync(path, "replacement\n", { mode: 0o600 });
      },
    });
    store.appendCompletedTurn(turn("swap-file", "turn-1"));

    expect(() => store.readCurrentConversation("swap-file")).toThrow(UnsafeTranscriptTargetError);
    expect(readFileSync(`${path}.original`, "utf8")).toContain("turn-1");
    expect(readFileSync(path, "utf8")).toBe("replacement\n");
  });

  it("detects directory mode drift and never repairs it", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const directory = join(dataDir, "transcripts");
    store.appendCompletedTurn(turn("mode-drift", "turn-1"));
    const path = transcriptPath(dataDir, "mode-drift");
    const before = readFileSync(path);
    chmodSync(directory, 0o755);

    expect(() => store.readCurrentConversation("mode-drift")).toThrow(UnsafeTranscriptTargetError);
    expect(() => store.appendCompletedTurn(turn("mode-drift", "turn-2"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(readFileSync(path)).toEqual(before);
    expect(lstatSync(directory).mode & 0o7777).toBe(0o755);
  });

  it("detects a transcript directory swapped between operations", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const directory = join(dataDir, "transcripts");
    store.appendCompletedTurn(turn("directory-swap", "turn-1"));
    const original = readFileSync(transcriptPath(dataDir, "directory-swap"));
    renameSync(directory, `${directory}.original`);
    mkdirSync(directory, { mode: 0o700 });

    expect(() => store.readCurrentConversation("directory-swap")).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(() => store.appendCompletedTurn(turn("directory-swap", "turn-2"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(
      readFileSync(
        join(
          `${directory}.original`,
          `${createHash("sha256").update("directory-swap").digest("hex")}.jsonl`,
        ),
      ),
    ).toEqual(original);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("detects a directory swap after a child is opened and before any append", () => {
    const dataDir = makeDataDir();
    const directory = join(dataDir, "transcripts");
    let swapped = false;
    const store = new TranscriptStore(dataDir, {
      afterChildOpen: () => {
        if (swapped) return;
        swapped = true;
        renameSync(directory, `${directory}.original`);
        mkdirSync(directory, { mode: 0o700 });
      },
    });

    expect(() => store.appendCompletedTurn(turn("mid-open-swap", "turn-1"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(readdirSync(`${directory}.original`)).toHaveLength(1);
    const name = readdirSync(`${directory}.original`)[0];
    expect(readFileSync(join(`${directory}.original`, name))).toHaveLength(0);
  });

  it("refuses an existing permissive transcript directory and a symlink directory", () => {
    const permissiveDataDir = makeDataDir();
    mkdirSync(join(permissiveDataDir, "transcripts"), { mode: 0o755 });
    expect(() => new TranscriptStore(permissiveDataDir)).toThrow(UnsafeTranscriptTargetError);
    expect(lstatSync(join(permissiveDataDir, "transcripts")).mode & 0o7777).toBe(0o755);

    const symlinkDataDir = makeDataDir();
    const outside = join(symlinkDataDir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(symlinkDataDir, "transcripts"));
    expect(() => new TranscriptStore(symlinkDataDir)).toThrow(UnsafeTranscriptTargetError);
  });

  it("refuses a pre-existing unsafe reset-intent target without overwriting it", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("unsafe-intent", RESET_ID_B);
    const target = intentPath(dataDir, reset.chatId);
    writeFileSync(target, "pre-existing\n", { mode: 0o644 });

    expect(() => store.createResetIntent(reset)).toThrow(UnsafeTranscriptTargetError);
    expect(readFileSync(target, "utf8")).toBe("pre-existing\n");
    expect(lstatSync(target).mode & 0o7777).toBe(0o644);
  });

  it("refuses a pre-existing symlink reset-intent temp without following it", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("unsafe-temp", RESET_ID_B);
    const outside = join(dataDir, "outside-intent.json");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    const digest = createHash("sha256").update(reset.chatId, "utf8").digest("hex");
    const temp = join(dataDir, "transcripts", `${digest}.${reset.resetId}.reset-intent.tmp`);
    symlinkSync(outside, temp);

    expect(() => store.createResetIntent(reset)).toThrow(UnsafeTranscriptTargetError);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
  });

  it("refuses a hardlinked reset-intent target", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("hardlinked-intent");
    store.createResetIntent(reset);
    linkSync(intentPath(dataDir, reset.chatId), join(dataDir, "shared-intent.json"));

    expect(() => store.readResetIntent(reset.chatId)).toThrow(UnsafeTranscriptTargetError);
  });
});
