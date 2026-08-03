import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelegramUpdateOffsetStore,
  tokenFingerprint,
  MAX_DISPATCHED_IDS,
  UPDATE_ID_EPOCH_INACTIVITY_MS,
} from "../src/channels/telegram-update-offsets.js";

const TOKEN = "123456:ABC-DEF-super-secret-bot-token";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-offsets-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("tokenFingerprint", () => {
  it("is a deterministic 16-hex-char digest that is not the raw token", () => {
    const fp = tokenFingerprint(TOKEN);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toBe(tokenFingerprint(TOKEN));
    expect(fp).not.toContain(TOKEN);
    expect(tokenFingerprint("other")).not.toBe(fp);
  });
});

describe("TelegramUpdateOffsetStore — dispatch dedupe", () => {
  it("accepts a lower update id in a new inactivity epoch after restart", () => {
    let now = Date.UTC(1998, 5, 1);
    const clock = { now: () => now };
    const initial = new TelegramUpdateOffsetStore(dataDir, TOKEN, clock);
    expect(initial.shouldDispatch(900)).toBe(true);

    now += UPDATE_ID_EPOCH_INACTIVITY_MS;
    const restarted = new TelegramUpdateOffsetStore(dataDir, TOKEN, clock);
    expect(restarted.shouldDispatch(100)).toBe(true);
    expect(restarted.shouldDispatch(100)).toBe(false);
  });

  it("uses a version-1 file timestamp to upgrade an inactive store", () => {
    const path = join(dataDir, `telegram-offsets.${tokenFingerprint(TOKEN)}.json`);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, lastUpdateId: 900, dispatchedUpdateIds: [900] }),
      { mode: 0o600 },
    );
    const lastAccepted = Date.UTC(1998, 5, 1);
    utimesSync(path, new Date(lastAccepted), new Date(lastAccepted));

    const beforeBoundary = new TelegramUpdateOffsetStore(dataDir, TOKEN, {
      now: () => lastAccepted + UPDATE_ID_EPOCH_INACTIVITY_MS - 1,
    });
    expect(beforeBoundary.shouldDispatch(100)).toBe(false);

    const restarted = new TelegramUpdateOffsetStore(dataDir, TOKEN, {
      now: () => lastAccepted + UPDATE_ID_EPOCH_INACTIVITY_MS,
    });
    expect(restarted.shouldDispatch(100)).toBe(true);
    expect(restarted.shouldDispatch(100)).toBe(false);
  });

  it("upgrades an active version-1 store when a higher update arrives", () => {
    const path = join(dataDir, `telegram-offsets.${tokenFingerprint(TOKEN)}.json`);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, lastUpdateId: 900, dispatchedUpdateIds: [900] }),
      { mode: 0o600 },
    );
    const lastAccepted = Date.UTC(1998, 5, 1);
    utimesSync(path, new Date(lastAccepted), new Date(lastAccepted));
    const now = Date.UTC(1998, 5, 2);

    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN, { now: () => now });

    expect(store.shouldDispatch(901)).toBe(true);
    expect(store.load()).toMatchObject({
      version: 2,
      lastUpdateId: 901,
      lastAcceptedAtMs: now,
      dispatchedUpdateIds: [900, 901],
    });
  });

  it("fails open when a version-2 store has no valid epoch timestamp", () => {
    const path = join(dataDir, `telegram-offsets.${tokenFingerprint(TOKEN)}.json`);
    writeFileSync(
      path,
      JSON.stringify({ version: 2, lastUpdateId: 900, dispatchedUpdateIds: [900] }),
      { mode: 0o600 },
    );
    const now = Date.UTC(1998, 5, 8);

    const restarted = new TelegramUpdateOffsetStore(dataDir, TOKEN, { now: () => now });

    expect(restarted.shouldDispatch(100)).toBe(true);
    expect(restarted.load().lastAcceptedAtMs).toBe(now);
  });

  it("fails open when the persisted store version is unsupported", () => {
    const path = join(dataDir, `telegram-offsets.${tokenFingerprint(TOKEN)}.json`);
    writeFileSync(
      path,
      JSON.stringify({ version: 99, lastUpdateId: 900, dispatchedUpdateIds: [900] }),
      { mode: 0o600 },
    );

    const restarted = new TelegramUpdateOffsetStore(dataDir, TOKEN);

    expect(restarted.shouldDispatch(100)).toBe(true);
  });

  it("fails open when persisted update ids violate the writer invariant", () => {
    const path = join(dataDir, `telegram-offsets.${tokenFingerprint(TOKEN)}.json`);
    const now = Date.UTC(1998, 5, 8);
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        lastUpdateId: 0,
        lastAcceptedAtMs: now,
        dispatchedUpdateIds: [100],
      }),
      { mode: 0o600 },
    );

    const restarted = new TelegramUpdateOffsetStore(dataDir, TOKEN, { now: () => now });

    expect(restarted.shouldDispatch(100)).toBe(true);
  });

  it("does not move the epoch timestamp backward when the system clock rolls back", () => {
    const latestWallTime = Date.UTC(1998, 5, 8);
    let now = latestWallTime;
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN, { now: () => now });
    expect(store.shouldDispatch(900)).toBe(true);

    now = Date.UTC(1998, 5, 1);
    expect(store.shouldDispatch(901)).toBe(true);

    now = latestWallTime;
    expect(store.shouldDispatch(100)).toBe(false);
    expect(store.load().lastAcceptedAtMs).toBe(latestWallTime);
  });

  it("dispatches a new update once and skips an exact replay", () => {
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    expect(store.shouldDispatch(10)).toBe(true);
    expect(store.shouldDispatch(10)).toBe(false);
  });

  it("skips any update id at or below the persisted offset", () => {
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    expect(store.shouldDispatch(20)).toBe(true);
    expect(store.shouldDispatch(15)).toBe(false);
    expect(store.shouldDispatch(20)).toBe(false);
    expect(store.shouldDispatch(21)).toBe(true);
  });

  it("persists the dedupe log across store instances (restart)", () => {
    new TelegramUpdateOffsetStore(dataDir, TOKEN).shouldDispatch(42);
    const afterRestart = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    expect(afterRestart.shouldDispatch(42)).toBe(false);
    expect(afterRestart.shouldDispatch(43)).toBe(true);
  });

  it("bounds the dispatched-id ring around the configured cap", () => {
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    for (let id = 1; id <= MAX_DISPATCHED_IDS + 50; id++) store.shouldDispatch(id);
    const state = store.load();
    expect(state.dispatchedUpdateIds.length).toBeLessThanOrEqual(MAX_DISPATCHED_IDS);
    // The offset high-water mark still dedupes ids evicted from the ring.
    expect(store.shouldDispatch(1)).toBe(false);
    expect(state.lastUpdateId).toBe(MAX_DISPATCHED_IDS + 50);
  });

  it("stores no raw bot token — only its fingerprint appears (in the filename)", () => {
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    store.shouldDispatch(7);
    const files = readdirSync(dataDir);
    const offsetFile = files.find((f) => f.startsWith("telegram-offsets."));
    expect(offsetFile).toBeDefined();
    expect(offsetFile).toContain(tokenFingerprint(TOKEN));
    expect(offsetFile).not.toContain(TOKEN);
    const raw = readFileSync(join(dataDir, offsetFile!), "utf-8");
    expect(raw).not.toContain(TOKEN);
  });

  it("fails open — dispatches when the store cannot be persisted", () => {
    const store = new TelegramUpdateOffsetStore(join(dataDir, "does", "not", "exist"), TOKEN);
    expect(store.shouldDispatch(5)).toBe(true);
    expect(store.shouldDispatch(5)).toBe(true);
  });
});

describe("TelegramUpdateOffsetStore — self-update marker", () => {
  it("persists the marker and dedupes the /update's own update id after restart", () => {
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    store.recordSelfUpdate({
      updateId: 99,
      chatId: 777,
      ts: "1998-06-01T00:00:00.000Z",
      targetVersion: "2026.6.1",
    });
    const restarted = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    expect(restarted.load().selfUpdate).toEqual({
      updateId: 99,
      chatId: 777,
      ts: "1998-06-01T00:00:00.000Z",
      targetVersion: "2026.6.1",
    });
    // The re-delivered /update after the restart is deduped.
    expect(restarted.shouldDispatch(99)).toBe(false);
  });

  it("accepts a marker with a null update id (direct handler invocation)", () => {
    const store = new TelegramUpdateOffsetStore(dataDir, TOKEN);
    expect(() =>
      store.recordSelfUpdate({
        updateId: null,
        chatId: 1,
        ts: "1998-06-01T00:00:00.000Z",
        targetVersion: "2026.6.1",
      }),
    ).not.toThrow();
    expect(store.load().selfUpdate?.updateId).toBeNull();
  });

  it("throws when the marker cannot be written (so /update can decline to stop)", () => {
    const store = new TelegramUpdateOffsetStore(join(dataDir, "missing"), TOKEN);
    expect(() =>
      store.recordSelfUpdate({
        updateId: 1,
        chatId: 1,
        ts: "1998-06-01T00:00:00.000Z",
        targetVersion: "2026.6.1",
      }),
    ).toThrow();
  });
});
