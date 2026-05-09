import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAllowedSenders,
  saveAllowedSenders,
  defaultPairingState,
  addSender,
  removeSender,
  listSenders,
  readKnownSessions,
  type AllowedSenders,
} from "../src/channels/allowed-senders.js";

let dataDir: string;
const ENV_KEYS = ["CYCLING_COACH_OPERATOR_ID"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-allowlist-"));
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("loadAllowedSenders — defaults", () => {
  it("returns default-pairing state when no file and no env-var (fresh install)", () => {
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
    expect(result.primaryOperator).toBeNull();
    expect(result.version).toBe(1);
    expect(result.capturedAt).toBeNull();
    expect(result.addedAt).toEqual({});
  });
});

describe("loadAllowedSenders — CYCLING_COACH_OPERATOR_ID env-var", () => {
  it("CYCLING_COACH_OPERATOR_ID=12345 → allowlist mode with single operator", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "12345";
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["12345"]);
    expect(result.primaryOperator).toBe("12345");
  });

  it("=0 (leading zero) → rejected, falls through to default + log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "0";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security]"));
    errSpy.mockRestore();
  });

  it("=abc (non-numeric) → rejected, falls through to default", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "abc";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("= (empty) → ignored silently, falls through to default", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).not.toHaveBeenCalled(); // empty is "unset", no warn
    errSpy.mockRestore();
  });

  it("=1 (single digit, fails ≥2-digit rule) → rejected", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CYCLING_COACH_OPERATOR_ID = "1";
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
  });
});

describe("loadAllowedSenders — file precedence", () => {
  it("file present beats env-var (file > env > default)", () => {
    process.env.CYCLING_COACH_OPERATOR_ID = "99999";
    writeFileSync(
      join(dataDir, "allowed-senders.json"),
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: "2026-05-09T10:00:00.000Z",
        addedAt: { "12345": "2026-05-09T10:00:00.000Z" },
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["12345"]);
    expect(result.primaryOperator).toBe("12345");
    expect(result.capturedAt).toBe("2026-05-09T10:00:00.000Z");
  });
});

describe("loadAllowedSenders — schema validation", () => {
  function writeRaw(content: string): void {
    writeFileSync(join(dataDir, "allowed-senders.json"), content);
  }

  it("malformed JSON → default-pairing, log to stderr (does NOT throw)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw("{not valid json");
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security]"));
    errSpy.mockRestore();
  });

  it("future version (version: 99) → default-pairing + log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 99,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result).toEqual(defaultPairingState());
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("version"));
    errSpy.mockRestore();
  });

  it("invalid dmPolicy → default-pairing + log", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "totally-not-a-policy",
        allowFrom: ["12345"],
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("dmPolicy"));
    errSpy.mockRestore();
  });

  it('S8: dmPolicy "open" from file is rejected → default-pairing (env-var-only)', () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "open",
        allowFrom: [],
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("dmPolicy"));
    errSpy.mockRestore();
  });

  it("missing dmPolicy → default-pairing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(JSON.stringify({ version: 1, allowFrom: ["12345"] }));
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
  });

  it("S2: allowFrom number entries coerced to strings", () => {
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: [12345],
        primaryOperator: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345"]);
  });

  it("S2: allowFrom not an array → fall back to pairing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("allowFrom"));
    errSpy.mockRestore();
  });

  it("S2: allowFrom invalid items filtered, valid items kept", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["abc", "0", "12345", null, "1", "67890"],
        primaryOperator: "12345",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["12345", "67890"]);
    // Per-dropped-item warning expected for each of: "abc", "0", null, "1"
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    errSpy.mockRestore();
  });

  it("S2: allowFrom empty after filtering AND allowlist mode → fall back to pairing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["abc", "0"],
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
  });

  it("forward-compat: unknown top-level fields preserved on load", () => {
    writeRaw(
      JSON.stringify({
        version: 1,
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: null,
        addedAt: {},
        // Hypothetical future fields:
        lastUsedAt: { "12345": "2026-05-09T10:00:00.000Z" },
        provenance: "wizard",
      }),
    );
    const result = loadAllowedSenders(dataDir);
    expect(result.lastUsedAt).toEqual({ "12345": "2026-05-09T10:00:00.000Z" });
    expect(result.provenance).toBe("wizard");
  });
});

describe("saveAllowedSenders — transformer pattern, round-trip", () => {
  it("transformer receives null on first save; resulting state is loadable", () => {
    const seenCurrent: Array<unknown> = [];
    const saved = saveAllowedSenders(dataDir, (current) => {
      seenCurrent.push(current);
      return {
        ...defaultPairingState(),
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        primaryOperator: "12345",
        capturedAt: "2026-05-09T10:00:00.000Z",
        addedAt: { "12345": "2026-05-09T10:00:00.000Z" },
      };
    });
    expect(seenCurrent).toEqual([null]);
    expect(saved.dmPolicy).toBe("allowlist");
    expect(saved.allowFrom).toEqual(["12345"]);

    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.dmPolicy).toBe("allowlist");
    expect(reloaded.allowFrom).toEqual(["12345"]);
    expect(reloaded.primaryOperator).toBe("12345");
    expect(reloaded.capturedAt).toBe("2026-05-09T10:00:00.000Z");
    expect(reloaded.addedAt).toEqual({ "12345": "2026-05-09T10:00:00.000Z" });
  });

  it("transformer receives current state on second save (read happens inside save)", () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const seen: Array<unknown> = [];
    saveAllowedSenders(dataDir, (current) => {
      seen.push(current);
      return {
        ...(current as AllowedSenders),
        allowFrom: [...((current as AllowedSenders).allowFrom), "67890"],
      };
    });
    expect(seen).toHaveLength(1);
    const seenState = seen[0] as AllowedSenders;
    expect(seenState.dmPolicy).toBe("allowlist");
    expect(seenState.allowFrom).toEqual(["12345"]);
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.allowFrom).toEqual(["12345", "67890"]);
  });

  it("forward-compat: round-trip through saveAllowedSenders preserves unknown top-level fields", () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
      lastUsedAt: { "12345": "2026-05-09T10:00:00.000Z" },
    }) as AllowedSenders);
    saveAllowedSenders(dataDir, (current) => ({
      ...(current as AllowedSenders),
      allowFrom: [...((current as AllowedSenders).allowFrom), "67890"],
    }));
    const reloaded = loadAllowedSenders(dataDir);
    expect(reloaded.lastUsedAt).toEqual({ "12345": "2026-05-09T10:00:00.000Z" });
    expect(reloaded.allowFrom).toEqual(["12345", "67890"]);
  });
});

describe("addSender / removeSender — validation and lifecycle", () => {
  it('addSender("abc") throws (non-numeric)', () => {
    expect(() => addSender(dataDir, "abc")).toThrow(/positive integer/);
  });

  it('addSender("0") throws (leading-zero rejected)', () => {
    expect(() => addSender(dataDir, "0")).toThrow(/positive integer/);
  });

  it('addSender("1") throws (single-digit rejected by ^[1-9]\\d+$)', () => {
    expect(() => addSender(dataDir, "1")).toThrow(/positive integer/);
  });

  it('addSender("12345") then removeSender("12345") cycles dmPolicy: pairing → allowlist → pairing', () => {
    expect(loadAllowedSenders(dataDir).dmPolicy).toBe("pairing");

    addSender(dataDir, "12345");
    const afterAdd = loadAllowedSenders(dataDir);
    expect(afterAdd.dmPolicy).toBe("allowlist");
    expect(afterAdd.allowFrom).toEqual(["12345"]);
    expect(afterAdd.primaryOperator).toBe("12345");
    expect(afterAdd.addedAt["12345"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    removeSender(dataDir, "12345");
    const afterRemove = loadAllowedSenders(dataDir);
    expect(afterRemove.dmPolicy).toBe("pairing");
    expect(afterRemove.allowFrom).toEqual([]);
    expect(afterRemove.primaryOperator).toBeNull();
    expect(afterRemove.addedAt["12345"]).toBeUndefined();
  });

  it("addSender is idempotent — re-adding the same id is a no-op for allowFrom", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "12345");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345"]);
  });

  it("addSender preserves existing allowFrom (Set-union); does not change primaryOperator if already set", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "67890");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345", "67890"]);
    expect(result.primaryOperator).toBe("12345"); // first sender stays primary
  });

  it("removeSender on non-allowlisted id is a no-op (does not throw)", () => {
    addSender(dataDir, "12345");
    removeSender(dataDir, "99999");
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
  });

  it("removeSender of primaryOperator clears primaryOperator (other entries promoted to no-primary)", () => {
    addSender(dataDir, "12345");
    addSender(dataDir, "67890");
    removeSender(dataDir, "12345");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["67890"]);
    expect(result.primaryOperator).toBeNull();
  });
});

describe("saveAllowedSenders — PID lockfile", () => {
  const lockPath = () => join(dataDir, ".allowed-senders.lock");

  it("happy path: two writes in series both succeed; lockfile is cleaned between", () => {
    addSender(dataDir, "12345");
    expect(existsSync(lockPath())).toBe(false);
    addSender(dataDir, "67890");
    expect(existsSync(lockPath())).toBe(false);
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345", "67890"]);
  });

  it("contention with live PID + fresh timestamp → LockfileContentionError", async () => {
    const { LockfileContentionError } = await import(
      "../src/channels/allowed-senders.js"
    );
    // Plant a lockfile claiming THIS process owns it (this process IS alive).
    writeFileSync(lockPath(), `${process.pid}\n${new Date().toISOString()}`);
    expect(() => addSender(dataDir, "12345")).toThrow(LockfileContentionError);
    // Cleanup so afterEach doesn't fail
    rmSync(lockPath(), { force: true });
  });

  it("stale lockfile (dead PID, old timestamp) is reclaimed", () => {
    // PID 999999 is almost certainly not alive; old timestamp regardless ensures reclaim.
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(lockPath(), `999999\n${oldTs}`);
    addSender(dataDir, "12345");
    expect(existsSync(lockPath())).toBe(false);
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
  });

  it("malformed lockfile is treated as stale and reclaimed", () => {
    writeFileSync(lockPath(), "this is not a valid lockfile");
    addSender(dataDir, "12345");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("T1 (CRITICAL): concurrent addSender preserves both writes (transformer pattern)", async () => {
    // In a single process this is serial via the sync save loop; the test guards
    // against any future refactor that re-introduces load-then-save-outside-lock.
    await Promise.all([
      Promise.resolve().then(() => addSender(dataDir, "11111")),
      Promise.resolve().then(() => addSender(dataDir, "22222")),
    ]);
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom.sort()).toEqual(["11111", "22222"]);
  });

  it("T1: corrupt file → next addSender succeeds via defaultPairingState() base", () => {
    writeFileSync(join(dataDir, "allowed-senders.json"), "{not valid json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    addSender(dataDir, "12345");
    const result = loadAllowedSenders(dataDir);
    expect(result.allowFrom).toEqual(["12345"]);
    expect(result.dmPolicy).toBe("allowlist");
  });
});

describe("listSenders / readKnownSessions", () => {
  function seedSession(chatId: string, lines: number): void {
    const sessionsDir = join(dataDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const file = join(sessionsDir, `telegram:${chatId}.jsonl`);
    const content = Array.from({ length: lines })
      .map((_, i) => JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant", content: "x", ts: Date.now() }))
      .join("\n");
    writeFileSync(file, content);
  }

  it("readKnownSessions returns chatId/lineCount/mtime per session file", async () => {
    seedSession("12345", 4);
    seedSession("67890", 12);
    const sessions = await readKnownSessions(dataDir);
    const byId = new Map(sessions.map((s) => [s.chatId, s]));
    expect(byId.get("12345")?.lineCount).toBe(4);
    expect(byId.get("67890")?.lineCount).toBe(12);
    expect(byId.get("12345")?.mtime).toBeGreaterThan(0);
  });

  it("readKnownSessions returns empty array when sessions dir does not exist", async () => {
    expect(await readKnownSessions(dataDir)).toEqual([]);
  });

  it("listSenders returns current allowed-senders state plus session candidates", async () => {
    addSender(dataDir, "12345");
    seedSession("12345", 4);
    seedSession("99999", 2);
    const result = await listSenders(dataDir);
    expect(result.senders.dmPolicy).toBe("allowlist");
    expect(result.senders.allowFrom).toEqual(["12345"]);
    expect(result.sessionCandidates.length).toBe(2);
    const chatIds = result.sessionCandidates.map((c) => c.chatId).sort();
    expect(chatIds).toEqual(["12345", "99999"]);
  });
});

describe("loadAllowedSenders — mtime cache", () => {
  it("re-uses parsed state when mtime is unchanged (cache hit)", () => {
    addSender(dataDir, "12345");
    // First call populates / refreshes the cache.
    const first = loadAllowedSenders(dataDir);
    // Spy on JSON.parse to detect cache hits.
    const parseSpy = vi.spyOn(JSON, "parse");
    const second = loadAllowedSenders(dataDir);
    const third = loadAllowedSenders(dataDir);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    parseSpy.mockRestore();
  });

  it("write via saveAllowedSenders → next load reflects the change", () => {
    addSender(dataDir, "12345");
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345"]);
    addSender(dataDir, "67890");
    expect(loadAllowedSenders(dataDir).allowFrom).toEqual(["12345", "67890"]);
  });

  it("file deleted out-of-band → cache cleared, default returned", () => {
    addSender(dataDir, "12345");
    expect(loadAllowedSenders(dataDir).dmPolicy).toBe("allowlist");
    rmSync(join(dataDir, "allowed-senders.json"));
    const result = loadAllowedSenders(dataDir);
    expect(result.dmPolicy).toBe("pairing");
    expect(result.allowFrom).toEqual([]);
  });
});

describe("saveAllowedSenders — data-dir perms (S3)", () => {
  it("tightens pre-existing dataDir from 0o755 to 0o700 and logs", () => {
    chmodSync(dataDir, 0o755);
    expect(statSync(dataDir).mode & 0o777).toBe(0o755);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    addSender(dataDir, "12345");
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[security\].*permissions.*0o700/),
    );
    errSpy.mockRestore();
  });
});
