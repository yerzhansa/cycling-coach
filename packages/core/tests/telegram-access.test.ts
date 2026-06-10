import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateAccess,
  buildPairingChallenge,
  createAuthMiddleware,
} from "../src/channels/telegram-access.js";
import {
  defaultPairingState,
  saveAllowedSenders,
  type AllowedSenders,
} from "../src/channels/allowed-senders.js";

function makeAllowed(overrides: Partial<AllowedSenders> = {}): AllowedSenders {
  return { ...defaultPairingState(), ...overrides } as AllowedSenders;
}

function makeCtx(opts: {
  chatType?: "private" | "group" | "supergroup" | "channel";
  fromId?: number | string | undefined;
}): Context {
  const ctx: Partial<Context> = {};
  if (opts.chatType !== undefined) {
    (ctx as { chat?: unknown }).chat = { type: opts.chatType, id: 0 };
  }
  if (opts.fromId !== undefined) {
    (ctx as { from?: unknown }).from = { id: opts.fromId };
  }
  return ctx as Context;
}

describe("evaluateAccess — chat-type and from-id guards", () => {
  it("rejects non-private chats (group)", () => {
    const ctx = makeCtx({ chatType: "group", fromId: 12345 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }));
    expect(result.allow).toBe(false);
  });

  it("rejects non-private chats (channel)", () => {
    const ctx = makeCtx({ chatType: "channel", fromId: 12345 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }));
    expect(result.allow).toBe(false);
  });

  it("rejects when ctx.from is undefined (service messages)", () => {
    const ctx = makeCtx({ chatType: "private", fromId: undefined });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }));
    expect(result.allow).toBe(false);
  });

  it("rejects when typeof ctx.from.id !== 'number' (grammy version-drift guard)", () => {
    const ctx = makeCtx({ chatType: "private", fromId: "12345" as unknown as number });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"] }));
    expect(result.allow).toBe(false);
  });
});

describe("evaluateAccess — allowlist matching", () => {
  it("allows when String(from.id) ∈ allowFrom (allowlist mode)", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 12345 });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"], primaryOperator: "12345" }),
    );
    expect(result).toEqual({ allow: true });
  });

  it("allows when dmPolicy is 'open' (env-var-only escape hatch), flagged viaOpenPolicy", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 99999 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "open", allowFrom: [] }));
    expect(result).toEqual({ allow: true, viaOpenPolicy: true });
  });

  it("allows an allowlisted sender under open policy WITHOUT the viaOpenPolicy flag", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 12345 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "open", allowFrom: ["12345"] }));
    expect(result).toEqual({ allow: true });
  });

  it("denies (silent) when dmPolicy is 'allowlist' and sender not in allowFrom", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 99999 });
    const result = evaluateAccess(
      ctx,
      makeAllowed({ dmPolicy: "allowlist", allowFrom: ["12345"], primaryOperator: "12345" }),
    );
    expect(result.allow).toBe(false);
    expect(result.pairingChallenge).toBeUndefined();
  });

  it("emits pairingChallenge marker when dmPolicy is 'pairing' and sender not allowlisted", () => {
    const ctx = makeCtx({ chatType: "private", fromId: 99999 });
    const result = evaluateAccess(ctx, makeAllowed({ dmPolicy: "pairing", allowFrom: [] }));
    expect(result.allow).toBe(false);
    expect(result.pairingChallenge).toBe("99999");
  });
});

describe("buildPairingChallenge — HTML body", () => {
  it("includes sender's user-ID, owner CLI command, and 'ask the bot owner' fallback (S5)", () => {
    const html = buildPairingChallenge("99999", "Stranger", "cycling-coach");
    expect(html).toContain("99999");
    expect(html).toContain("cycling-coach add-sender 99999");
    expect(html).toContain("ask the bot owner");
  });

  it("HTML-escapes sender name (XSS in pairing reply)", () => {
    const html = buildPairingChallenge("99999", "<script>alert(1)</script>", "cycling-coach");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes ampersand and quote in sender name", () => {
    const html = buildPairingChallenge("99999", 'Bob & "the Builder"', "cycling-coach");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("HTML-escapes binaryName defensively (constant in practice)", () => {
    const html = buildPairingChallenge("99999", undefined, "evil<bin>");
    expect(html).not.toContain("<bin>");
    expect(html).toContain("&lt;bin&gt;");
  });

  it("handles undefined senderName (service-message edge)", () => {
    const html = buildPairingChallenge("99999", undefined, "cycling-coach");
    expect(html).toContain("99999");
  });

  it("accepts numeric senderId and stringifies it", () => {
    const html = buildPairingChallenge(12345, "Alice", "cycling-coach");
    expect(html).toContain("12345");
  });
});

describe("createAuthMiddleware — gating", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-mw-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeMwCtx(opts: {
    chatType?: "private" | "group";
    fromId?: number;
    fromFirstName?: string;
  }): Context & { reply: ReturnType<typeof vi.fn> } {
    const ctx: Record<string, unknown> = {
      reply: vi.fn(async () => undefined),
    };
    if (opts.chatType !== undefined) {
      ctx.chat = { type: opts.chatType, id: opts.fromId ?? 0 };
    }
    if (opts.fromId !== undefined) {
      ctx.from = { id: opts.fromId, first_name: opts.fromFirstName };
    }
    return ctx as Context & { reply: ReturnType<typeof vi.fn> };
  }

  it("calls next() for allowed senders (allowlist mode)", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 12345 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("sends pairing-challenge HTML and does NOT call next() for stranger in pairing mode", async () => {
    // dataDir empty + no env → default-pairing mode
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999, fromFirstName: "Stranger" });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [html, options] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(html).toContain("99999");
    expect(html).toContain("cycling-coach add-sender 99999");
    expect(options).toEqual({ parse_mode: "HTML" });
  });

  it("does NOT call next() for stranger in allowlist mode (silent drop, no reply)", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("rate-limit (H2): same sender messaging twice within window → only one reply", async () => {
    const map = new Map<string, number>();
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const ctx1 = makeMwCtx({ chatType: "private", fromId: 99999 });
    const ctx2 = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx1, next);
    await mw(ctx2, next);
    expect(ctx1.reply).toHaveBeenCalledTimes(1);
    expect(ctx2.reply).not.toHaveBeenCalled();
  });

  it("rate-limit: different senders are rate-limited independently", async () => {
    const map = new Map<string, number>();
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const ctxA = makeMwCtx({ chatType: "private", fromId: 11111 });
    const ctxB = makeMwCtx({ chatType: "private", fromId: 22222 });
    const next = vi.fn(async () => undefined);
    await mw(ctxA, next);
    await mw(ctxB, next);
    expect(ctxA.reply).toHaveBeenCalledTimes(1);
    expect(ctxB.reply).toHaveBeenCalledTimes(1);
  });

  it("rate-limit: same sender after window elapses → second reply fires", async () => {
    const map = new Map<string, number>();
    // Pre-seed map to simulate the previous reply was 70s ago.
    map.set("99999", Date.now() - 70_000);
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("rate-limit map LRU bound: 1001 distinct senders → map size stays ≤ 1000", async () => {
    const map = new Map<string, number>();
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: map,
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    for (let i = 0; i < 1001; i++) {
      const ctx = makeMwCtx({ chatType: "private", fromId: 100000 + i });
      // eslint-disable-next-line no-await-in-loop
      await mw(ctx, next);
    }
    expect(map.size).toBeLessThanOrEqual(1000);
    // The *last-seen* sender should still be in the map (not the first).
    expect(map.has("101000")).toBe(true);
    expect(map.has("100000")).toBe(false);
  });

  it("open policy (env): serves non-allowlisted sender but warns to stderr once per sender", async () => {
    vi.stubEnv("CYCLING_COACH_DM_POLICY", "open");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    await mw(makeMwCtx({ chatType: "private", fromId: 99999 }), next);
    await mw(makeMwCtx({ chatType: "private", fromId: 99999 }), next);
    expect(next).toHaveBeenCalledTimes(2);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("Open DM policy"));
    expect(warnings.length).toBe(1);
    expect(String(warnings[0][0])).toContain("99999");
    errSpy.mockRestore();
  });

  it("open policy (env): distinct non-allowlisted senders each get one warning", async () => {
    vi.stubEnv("CYCLING_COACH_DM_POLICY", "open");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    await mw(makeMwCtx({ chatType: "private", fromId: 11111 }), next);
    await mw(makeMwCtx({ chatType: "private", fromId: 22222 }), next);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("Open DM policy"));
    expect(warnings.length).toBe(2);
    errSpy.mockRestore();
  });

  it("open policy (env): allowlisted sender is served without the open-policy warning", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));
    vi.stubEnv("CYCLING_COACH_DM_POLICY", "open");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: new Map(),
      challengeMinIntervalMs: 60_000,
    });
    const next = vi.fn(async () => undefined);
    await mw(makeMwCtx({ chatType: "private", fromId: 12345 }), next);
    expect(next).toHaveBeenCalledTimes(1);
    const warnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("Open DM policy"));
    expect(warnings.length).toBe(0);
    errSpy.mockRestore();
  });

  it("fail-closed: load throws → drops update without calling next() and logs to stderr", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Use an obviously-illegal dataDir so loadAllowedSenders+saveAllowedSenders throw.
    // (loadAllowedSenders by itself only logs — but the inner ensureDataDirSecure inside
    // a real save would throw on a bad path. To force a throw inside load, we instead
    // pass a path that triggers the JSON read error: write a directory in place of the file.)
    // Simpler: throw from a custom middleware via stubbing — use a Map proxy that throws.
    const throwingMap = new Proxy(new Map<string, number>(), {
      get(_target, prop) {
        if (prop === "get") {
          return () => { throw new Error("synthetic boom"); };
        }
        return Reflect.get(_target, prop);
      },
    }) as Map<string, number>;
    const mw = createAuthMiddleware({
      dataDir,
      binaryName: "cycling-coach",
      challengeRateLimit: throwingMap,
      challengeMinIntervalMs: 60_000,
    });
    const ctx = makeMwCtx({ chatType: "private", fromId: 99999 });
    const next = vi.fn(async () => undefined);
    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[security] middleware error"));
    errSpy.mockRestore();
  });
});
