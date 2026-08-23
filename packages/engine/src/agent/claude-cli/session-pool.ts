import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";

import { sha256_16 } from "../prompt-lineage.js";
import {
  readCursorStore,
  writeCursorStore,
  type CursorStoreDocument,
  type PersistedCursor,
} from "./cursor-store.js";

export const CLAUDE_CLI_KILL_SWITCH_ENV = "ENDURAGENT_CLAUDE_CLI_DISABLED";

export const CLAUDE_CLI_CHAT_LANE = "chat";

export const CLAUDE_CLI_DISABLED_MESSAGE =
  "The Claude CLI provider is disabled on this instance (ENDURAGENT_CLAUDE_CLI_DISABLED or llm.claude_cli.enabled: false). Choose another provider or re-enable it.";

export class ClaudeCliDisabledError extends Error {
  constructor() {
    super(CLAUDE_CLI_DISABLED_MESSAGE);
    this.name = "ClaudeCliDisabledError";
  }
}

export function isKillSwitchValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function assertClaudeCliEnabled(
  enabled: boolean,
  baseEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (enabled === false || isKillSwitchValue(baseEnv[CLAUDE_CLI_KILL_SWITCH_ENV])) {
    throw new ClaudeCliDisabledError();
  }
}

export type SessionKey = string;

export interface SessionCursor {
  sessionId: string;
  historyHash: string;
  dirty: boolean;
}

export interface AcquiredSession {
  cursor: SessionCursor | null;
  mode: "resume" | "rebuild";
}

export function claudeCliSessionKey(chatIdHash: string, lane: string, model: string): SessionKey {
  return `${chatIdHash}\0${lane}\0${model}`;
}

export function hashHistory(messages: readonly ModelMessage[]): string {
  const basis = messages.map((message) => ({ role: message.role, content: message.content }));
  return sha256_16(JSON.stringify(basis));
}

export interface ClaudeCliSessionPoolConfig {
  enabled: boolean;
  cursorStorePath: string;
}

export interface ClaudeCliSessionPoolPorts {
  readonly config: ClaudeCliSessionPoolConfig;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly newSessionId?: () => string;
}

export interface ClaudeCliSessionPool {
  acquire(key: SessionKey, historyHash: string): Promise<AcquiredSession>;
  observeSessionId(key: SessionKey, sessionId: string): void;
  markDirty(key: SessionKey): void;
  commit(key: SessionKey, cursor: PersistedCursor): Promise<void>;
  invalidate(key: SessionKey): void;
  dispose(): Promise<void>;
  mintSessionId(): string;
}

class FileBackedSessionPool implements ClaudeCliSessionPool {
  private readonly ports: ClaudeCliSessionPoolPorts;
  private readonly entries = new Map<SessionKey, SessionCursor>();
  private readonly dirtyKeys = new Set<SessionKey>();
  private loaded = false;
  private pendingWrite = false;

  constructor(ports: ClaudeCliSessionPoolPorts) {
    this.ports = ports;
  }

  private get env(): NodeJS.ProcessEnv {
    return this.ports.baseEnv ?? process.env;
  }

  private load(): void {
    if (this.loaded) return;
    const read = readCursorStore(this.ports.config.cursorStorePath);
    this.entries.clear();
    for (const [key, cursor] of Object.entries(read.cursors)) {
      this.entries.set(key, {
        sessionId: cursor.sessionId,
        historyHash: cursor.historyHash,
        dirty: false,
      });
    }
    this.loaded = true;
    this.pendingWrite = read.quarantinedPath !== undefined;
  }

  private document(): CursorStoreDocument {
    const out = Object.create(null) as CursorStoreDocument;
    for (const [key, cursor] of this.entries) {
      if (cursor.dirty) continue;
      if (cursor.sessionId === "" || cursor.historyHash === "") continue;
      out[key] = { sessionId: cursor.sessionId, historyHash: cursor.historyHash };
    }
    return out;
  }

  private persist(): void {
    writeCursorStore(this.ports.config.cursorStorePath, this.document());
    this.pendingWrite = false;
  }

  async acquire(key: SessionKey, historyHash: string): Promise<AcquiredSession> {
    try {
      assertClaudeCliEnabled(this.ports.config.enabled, this.env);
    } catch (error) {
      await this.dispose();
      throw error;
    }
    this.load();
    const entry = this.entries.get(key);
    if (entry !== undefined && !entry.dirty && entry.historyHash === historyHash) {
      return { cursor: { ...entry }, mode: "resume" };
    }
    if (entry !== undefined) {
      this.entries.delete(key);
      this.pendingWrite = true;
    }
    return { cursor: null, mode: "rebuild" };
  }

  observeSessionId(key: SessionKey, sessionId: string): void {
    if (sessionId === "") return;
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.entries.set(key, { sessionId, historyHash: "", dirty: false });
      return;
    }
    if (entry.sessionId === sessionId) return;
    entry.sessionId = sessionId;
  }

  markDirty(key: SessionKey): void {
    const entry = this.entries.get(key);
    this.dirtyKeys.add(key);
    this.pendingWrite = true;
    if (entry === undefined) {
      this.entries.set(key, { sessionId: "", historyHash: "", dirty: true });
      return;
    }
    entry.dirty = true;
  }

  async commit(key: SessionKey, cursor: PersistedCursor): Promise<void> {
    const markedDirty = this.dirtyKeys.delete(key);
    const wasDirty = markedDirty || this.entries.get(key)?.dirty === true;
    this.load();
    if (wasDirty || cursor.sessionId === "") {
      this.entries.delete(key);
    } else {
      this.entries.set(key, {
        sessionId: cursor.sessionId,
        historyHash: cursor.historyHash,
        dirty: false,
      });
    }
    this.persist();
  }

  invalidate(key: SessionKey): void {
    if (!this.entries.delete(key)) return;
    this.pendingWrite = true;
  }

  async dispose(): Promise<void> {
    if (this.loaded && this.pendingWrite) this.persist();
    this.entries.clear();
    this.loaded = false;
    this.pendingWrite = false;
  }

  mintSessionId(): string {
    return (this.ports.newSessionId ?? randomUUID)();
  }
}

export function createClaudeCliSessionPool(ports: ClaudeCliSessionPoolPorts): ClaudeCliSessionPool {
  return new FileBackedSessionPool(ports);
}
