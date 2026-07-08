import {
  createHash,
} from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Durable Telegram update-offset / dedupe store. Normal polling no longer drops
// pending updates on startup (so a message sent while the bot was down is still
// delivered on restart); this store is the safety that keeps a restart from
// re-processing an update the previous run already handled, and keeps a
// self-update `/update` from re-triggering itself after the restart.
//
// The store is owner-only JSON under dataDir, keyed by a short SHA-256 of the
// bot token so two bots sharing a dataDir never share a dedupe log. The raw
// token is NEVER written — only its fingerprint appears (in the filename).

// Bounded ring of recently dispatched update ids. Guards exact-replay dedupe
// (a crash mid-turn re-delivers an update whose id was already recorded).
export const MAX_DISPATCHED_IDS = 200;

const STORE_VERSION = 1 as const;

export interface SelfUpdateMarker {
  updateId: number | null;
  chatId: number;
  ts: string;
  targetVersion: string;
}

export interface UpdateOffsetState {
  version: typeof STORE_VERSION;
  lastUpdateId: number;
  dispatchedUpdateIds: number[];
  selfUpdate?: SelfUpdateMarker;
}

// Short, non-reversible fingerprint of the bot token. Only the first 16 hex
// chars are used — enough to disambiguate co-located bots, not enough to be a
// credential.
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function emptyState(): UpdateOffsetState {
  return { version: STORE_VERSION, lastUpdateId: 0, dispatchedUpdateIds: [] };
}

export class TelegramUpdateOffsetStore {
  private readonly path: string;

  constructor(dataDir: string, token: string) {
    this.path = join(dataDir, `telegram-offsets.${tokenFingerprint(token)}.json`);
  }

  load(): UpdateOffsetState {
    if (!existsSync(this.path)) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      return emptyState();
    }
    if (typeof parsed !== "object" || parsed === null) return emptyState();
    const v = parsed as Record<string, unknown>;
    const lastUpdateId = typeof v.lastUpdateId === "number" ? v.lastUpdateId : 0;
    const dispatchedUpdateIds = Array.isArray(v.dispatchedUpdateIds)
      ? v.dispatchedUpdateIds.filter((n): n is number => typeof n === "number")
      : [];
    const state: UpdateOffsetState = {
      version: STORE_VERSION,
      lastUpdateId,
      dispatchedUpdateIds,
    };
    const marker = v.selfUpdate;
    if (typeof marker === "object" && marker !== null) {
      const m = marker as Record<string, unknown>;
      if (
        typeof m.chatId === "number" &&
        typeof m.ts === "string" &&
        typeof m.targetVersion === "string"
      ) {
        state.selfUpdate = {
          updateId: typeof m.updateId === "number" ? m.updateId : null,
          chatId: m.chatId,
          ts: m.ts,
          targetVersion: m.targetVersion,
        };
      }
    }
    return state;
  }

  private save(state: UpdateOffsetState): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // Record an update id as dispatched, advancing the offset and the bounded ring.
  private record(state: UpdateOffsetState, updateId: number): void {
    if (!state.dispatchedUpdateIds.includes(updateId)) {
      state.dispatchedUpdateIds.push(updateId);
    }
    if (state.dispatchedUpdateIds.length > MAX_DISPATCHED_IDS) {
      state.dispatchedUpdateIds = state.dispatchedUpdateIds.slice(-MAX_DISPATCHED_IDS);
    }
    if (updateId > state.lastUpdateId) state.lastUpdateId = updateId;
  }

  // Returns true if this update should be dispatched, recording it first —
  // record before dispatch so a crash-mid-turn re-delivery dedupes safely.
  // Fails OPEN: a corrupt or unwritable store must never silence the athlete, so
  // any error means "dispatch it" rather than dropping the message.
  shouldDispatch(updateId: number): boolean {
    try {
      const state = this.load();
      if (updateId <= state.lastUpdateId) return false;
      if (state.dispatchedUpdateIds.includes(updateId)) return false;
      this.record(state, updateId);
      this.save(state);
      return true;
    } catch {
      return true;
    }
  }

  // Persist a self-update marker before `/update` stops the bot. The marker id
  // is recorded as dispatched so the re-delivered `/update` is deduped after the
  // restart. Throws on write failure so the caller can decline to stop.
  recordSelfUpdate(marker: SelfUpdateMarker): void {
    const state = this.load();
    state.selfUpdate = marker;
    if (typeof marker.updateId === "number") this.record(state, marker.updateId);
    this.save(state);
  }
}
