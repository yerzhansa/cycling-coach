import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-dispatch-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
  vi.doUnmock("../src/updater.js");
});

interface FakeBot {
  api: { sendMessage: ReturnType<typeof vi.fn> };
  use: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface StubAgent {
  chat: ReturnType<typeof vi.fn>;
  hasSession: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
}

interface StubReference {
  runSync: ReturnType<typeof vi.fn>;
  loadLatest: ReturnType<typeof vi.fn>;
}

interface BuildBotResult {
  bot: FakeBot;
  agent: StubAgent;
  reference: StubReference | undefined;
}

async function buildBot(opts?: {
  reference?: StubReference;
  stop?: () => Promise<void>;
}): Promise<BuildBotResult> {
  const bot: FakeBot = {
    api: { sendMessage: vi.fn(async () => undefined) },
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    stop: vi.fn(opts?.stop ?? (async () => undefined)),
  };
  vi.doMock("grammy", () => ({
    Bot: function FakeBot() {
      return bot;
    },
    InputFile: class {},
  }));

  const agent: StubAgent = {
    chat: vi.fn(),
    hasSession: vi.fn(),
    resetSession: vi.fn(),
  };

  const { createTelegramBot } = await import("../src/channels/telegram.js");
  createTelegramBot(
    "FAKE_TOKEN",
    agent as unknown as Parameters<typeof createTelegramBot>[1],
    cyclingBinary,
    dataDir,
    opts?.reference === undefined
      ? undefined
      : (opts.reference as unknown as Parameters<typeof createTelegramBot>[4]),
  );

  return { bot, agent, reference: opts?.reference };
}

function getCommand(bot: FakeBot, name: string) {
  const call = bot.command.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!call) throw new Error(`command ${name} not registered`);
  return call[1] as (ctx: unknown) => Promise<void>;
}

function getMessageText(bot: FakeBot) {
  const call = bot.on.mock.calls.find((c: unknown[]) => c[0] === "message:text");
  if (!call) throw new Error("message:text handler not registered");
  return call[1] as (ctx: unknown) => Promise<void>;
}

interface FakeCtx {
  chat: { id: number };
  match: string;
  message: { text: string };
  reply: ReturnType<typeof vi.fn>;
  replyWithDocument: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides?: Partial<FakeCtx>): FakeCtx {
  return {
    chat: { id: 777 },
    match: "",
    message: { text: "hi" },
    reply: vi.fn(async () => undefined),
    replyWithDocument: vi.fn(async () => undefined),
    ...overrides,
  };
}

function rateLimitError(retryAfterSec?: number): unknown {
  if (retryAfterSec !== undefined) {
    return new APICallError({
      message: "rate limited",
      url: "https://example.invalid/api",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": String(retryAfterSec) },
    });
  }
  return new Error("rate limit");
}

function replyTexts(ctx: FakeCtx): string[] {
  return ctx.reply.mock.calls.map((c: unknown[]) => String(c[0]));
}

function someReply(ctx: FakeCtx, needle: string): boolean {
  return replyTexts(ctx).some((t) => t.includes(needle));
}

describe("command registration", () => {
  it("registers all 10 commands when reference is provided", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const names = bot.command.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        "start",
        "plan",
        "workout",
        "status",
        "sync",
        "snapshot",
        "review",
        "version",
        "whatsnew",
        "update",
      ]),
    );
    expect(bot.on).toHaveBeenCalledWith("message:text", expect.any(Function));
  });

  it("omits /sync and /snapshot when reference is undefined", async () => {
    const { bot } = await buildBot();
    const names = bot.command.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).not.toContain("sync");
    expect(names).not.toContain("snapshot");
    for (const c of ["start", "plan", "workout", "status", "review", "version", "whatsnew", "update"]) {
      expect(names).toContain(c);
    }
  });
});

describe("agent-backed commands", () => {
  const messageFor: Record<string, string> = {
    plan: "/plan",
    workout: "/workout",
    status: "/status",
    review: "/review",
  };

  it.each(["plan", "workout", "status", "review"])(
    "%s: agent.chat success → response routed through sendLongMessage",
    async (name) => {
      const { bot, agent } = await buildBot();
      agent.chat.mockResolvedValue("ok");
      const ctx = makeCtx();
      await getCommand(bot, name)(ctx);
      expect(agent.chat).toHaveBeenCalledWith("telegram:777", messageFor[name]);
      const htmlReply = ctx.reply.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]).includes("ok") &&
          (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
      );
      expect(htmlReply).toBeDefined();
    },
  );

  it.each(["plan", "workout", "status", "review"])(
    "%s: agent.chat throws non-rate-limit → apology, never silent",
    async (name) => {
      const { bot, agent } = await buildBot();
      agent.chat.mockRejectedValue(new Error("boom"));
      const ctx = makeCtx();
      await getCommand(bot, name)(ctx);
      expect(someReply(ctx, "Sorry, something went wrong")).toBe(true);
      expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(["plan", "workout", "status", "review"])(
    "%s: agent.chat rate-limited → wait-time message",
    async (name) => {
      const { bot, agent } = await buildBot();
      agent.chat.mockRejectedValue(rateLimitError(30));
      const ctx = makeCtx();
      await getCommand(bot, name)(ctx);
      expect(someReply(ctx, "Rate limited — please try again in ~30 seconds.")).toBe(true);
    },
  );

  it("review with args forwards the args in the chat message", async () => {
    const { bot, agent } = await buildBot();
    agent.chat.mockResolvedValue("ok");
    const ctx = makeCtx({ match: "2026-05-01" });
    await getCommand(bot, "review")(ctx);
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "/review 2026-05-01");
    expect(someReply(ctx, "Reviewing your last session (2026-05-01)...")).toBe(true);
  });
});

describe("message:text — apology vs rate-limit fork", () => {
  it("agent.chat throw → apology (NOT silence)", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockReturnValue(true);
    agent.chat.mockRejectedValue(new Error("boom"));
    const ctx = makeCtx({ message: { text: "how's my form?" } });
    await getMessageText(bot)(ctx);
    expect(someReply(ctx, "Sorry, something went wrong. Please try again.")).toBe(true);
    expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("rate-limit with retry-after header → precise wait echoing the user text", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockReturnValue(true);
    agent.chat.mockRejectedValue(rateLimitError(45));
    const ctx = makeCtx({ message: { text: "plan my week" } });
    await getMessageText(bot)(ctx);
    expect(someReply(ctx, "Please wait ~45 seconds and resend:")).toBe(true);
    expect(someReply(ctx, "plan my week")).toBe(true);
  });

  it("rate-limit without header → default 'about a minute' wait", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockReturnValue(true);
    agent.chat.mockRejectedValue(new Error("rate limit"));
    const ctx = makeCtx({ message: { text: "ride plan" } });
    await getMessageText(bot)(ctx);
    expect(someReply(ctx, "about a minute")).toBe(true);
  });
});

describe("message:text — greet / re-greet logic", () => {
  it("first message from a newcomer (no session) → WELCOME then chat", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockReturnValue(false);
    agent.chat.mockResolvedValue("reply text");
    const ctx = makeCtx();
    await getMessageText(bot)(ctx);
    expect(String(ctx.reply.mock.calls[0][0]).startsWith("Welcome to Cycling Coach!")).toBe(true);
    expect(someReply(ctx, "reply text")).toBe(true);
  });

  it("returning user after restart (hasSession true) is NOT re-greeted", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockReturnValue(true);
    agent.chat.mockResolvedValue("reply text");
    const ctx = makeCtx();
    await getMessageText(bot)(ctx);
    expect(someReply(ctx, "Welcome to Cycling Coach!")).toBe(false);
  });

  it("second message in the same process is NOT re-greeted", async () => {
    const { bot, agent } = await buildBot();
    agent.hasSession.mockReturnValue(false);
    agent.chat.mockResolvedValue("reply text");
    const handler = getMessageText(bot);
    const ctx = makeCtx({ chat: { id: 775 } });
    await handler(ctx);
    await handler(ctx);
    const welcomeCount = replyTexts(ctx).filter((t) =>
      t.includes("Welcome to Cycling Coach!"),
    ).length;
    expect(welcomeCount).toBeLessThanOrEqual(1);
  });
});

describe("/snapshot — arg fallback", () => {
  it("no args → SNAPSHOT_HELP", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ match: "" });
    await getCommand(bot, "snapshot")(ctx);
    expect(someReply(ctx, "/snapshot raw")).toBe(true);
  });

  it("unknown subcommand → SNAPSHOT_HELP", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn() };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ match: "frobnicate" });
    await getCommand(bot, "snapshot")(ctx);
    expect(someReply(ctx, "/snapshot raw")).toBe(true);
  });

  it("'raw' with no synced data → 'hasn't synced yet' guidance", async () => {
    const reference: StubReference = { runSync: vi.fn(), loadLatest: vi.fn(() => null) };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx({ match: "raw" });
    await getCommand(bot, "snapshot")(ctx);
    expect(someReply(ctx, "hasn't synced yet")).toBe(true);
  });
});

describe("/update — ordering invariant", () => {
  it("REGRESSION: /update calls bot.stop() BEFORE selfUpdate (no infinite re-send loop)", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        selfUpdate,
      };
    });

    let releaseStop!: () => void;
    const stopP = new Promise<void>((r) => {
      releaseStop = r;
    });
    const { bot } = await buildBot({ stop: () => stopP });
    const ctx = makeCtx();

    await getCommand(bot, "update")(ctx);

    expect(bot.stop).toHaveBeenCalled();
    expect(selfUpdate).not.toHaveBeenCalled();

    releaseStop();
    await Promise.resolve();
    await Promise.resolve();

    expect(selfUpdate).toHaveBeenCalledWith("cycling-coach", "2026.5.10");
    expect(bot.stop.mock.invocationCallOrder[0]).toBeLessThan(
      selfUpdate.mock.invocationCallOrder[0],
    );
  });

  it("no update available → 'latest version' reply, no stop/selfUpdate", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.5",
          updateAvailable: false,
        })),
        selfUpdate,
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "update")(ctx);
    expect(someReply(ctx, "latest version")).toBe(true);
    expect(someReply(ctx, "2026.5.5")).toBe(true);
    expect(bot.stop).not.toHaveBeenCalled();
    expect(selfUpdate).not.toHaveBeenCalled();
  });

  it("checkForUpdate returns null → 'Could not check' reply", async () => {
    const selfUpdate = vi.fn();
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => null),
        selfUpdate,
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "update")(ctx);
    expect(someReply(ctx, "Could not check for updates. Try again later.")).toBe(true);
    expect(selfUpdate).not.toHaveBeenCalled();
  });
});

describe("version / whatsnew / sync", () => {
  it("/version → displayName + version", async () => {
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        getCurrentVersion: vi.fn(() => "2026.5.5"),
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "version")(ctx);
    expect(someReply(ctx, "Cycling Coach")).toBe(true);
    expect(someReply(ctx, "2026.5.5")).toBe(true);
  });

  it("/whatsnew: checkForUpdate null → npm-unreachable reply", async () => {
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>("../src/updater.js");
      return {
        ...real,
        checkForUpdate: vi.fn(async () => null),
      };
    });
    const { bot } = await buildBot();
    const ctx = makeCtx();
    await getCommand(bot, "whatsnew")(ctx);
    expect(someReply(ctx, "Couldn't reach npm")).toBe(true);
  });

  it("/sync success → runSync called and reply sent", async () => {
    const reference: StubReference = {
      runSync: vi.fn(async () => ({
        kind: "ran",
        lastSyncAt: "1998-05-09T14:23:00.000Z",
        refreshed: ["latest", "history"],
      })),
      loadLatest: vi.fn(),
    };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx();
    await getCommand(bot, "sync")(ctx);
    expect(reference.runSync).toHaveBeenCalledWith({ chatId: "telegram:777" });
    expect(someReply(ctx, "Syncing training data from intervals.icu...")).toBe(true);
    expect(someReply(ctx, "Sync")).toBe(true);
  });

  it("/sync throw → 'something went wrong syncing' apology", async () => {
    const reference: StubReference = {
      runSync: vi.fn(async () => {
        throw new Error("boom");
      }),
      loadLatest: vi.fn(),
    };
    const { bot } = await buildBot({ reference });
    const ctx = makeCtx();
    await getCommand(bot, "sync")(ctx);
    expect(someReply(ctx, "something went wrong syncing")).toBe(true);
  });
});

describe("long replies chunk via sendLongMessage", () => {
  it("a >4096-char agent reply arrives as multiple HTML chunks", async () => {
    const { bot, agent } = await buildBot();
    agent.chat.mockResolvedValue("x".repeat(9000));
    const ctx = makeCtx();
    await getCommand(bot, "status")(ctx);
    const htmlChunks = ctx.reply.mock.calls.filter(
      (c: unknown[]) => (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
    );
    expect(htmlChunks.length).toBeGreaterThan(1);
  });
});
