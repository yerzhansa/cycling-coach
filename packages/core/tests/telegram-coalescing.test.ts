import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import { CHAT_COALESCE_MS } from "../src/channels/telegram.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-coalesce-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
});

interface FakeBot {
  api: {
    sendMessage: ReturnType<typeof vi.fn>;
    setMyCommands: ReturnType<typeof vi.fn>;
    config: { use: ReturnType<typeof vi.fn> };
  };
  use: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  catch: ReturnType<typeof vi.fn>;
}

interface StubAgent {
  chat: ReturnType<typeof vi.fn>;
  hasSession: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
}

interface BuildBotResult {
  bot: FakeBot;
  agent: StubAgent;
  drainPending: () => Promise<void>;
}

async function buildBot(): Promise<BuildBotResult> {
  const bot: FakeBot = {
    api: {
      sendMessage: vi.fn(async () => undefined),
      setMyCommands: vi.fn(async () => true),
      config: { use: vi.fn() },
    },
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    stop: vi.fn(async () => undefined),
    catch: vi.fn(),
  };
  vi.doMock("grammy", () => ({
    Bot: function FakeBot() {
      return bot;
    },
    InputFile: class {},
  }));

  const agent: StubAgent = {
    chat: vi.fn(async () => "ok"),
    hasSession: vi.fn(() => true),
    resetSession: vi.fn(),
  };

  const { createTelegramBot } = await import("../src/channels/telegram.js");
  const { drainPending } = createTelegramBot(
    "FAKE_TOKEN",
    agent as unknown as Parameters<typeof createTelegramBot>[1],
    cyclingBinary,
    dataDir,
    undefined,
  );

  return { bot, agent, drainPending };
}

function getMessageText(bot: FakeBot) {
  const call = bot.on.mock.calls.find((c: unknown[]) => c[0] === "message:text");
  if (!call) throw new Error("message:text handler not registered");
  return call[1] as (ctx: unknown) => Promise<void>;
}

// The flush middleware is the SECOND bot.use registration (auth is first, in
// createSecuredBot).
function getFlushMiddleware(bot: FakeBot) {
  const call = bot.use.mock.calls[1];
  if (!call) throw new Error("flush middleware not registered");
  return call[0] as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

interface FakeCtx {
  chat: { id: number };
  match: string;
  message: { text: string; message_id?: number };
  reply: ReturnType<typeof vi.fn>;
  replyWithDocument: ReturnType<typeof vi.fn>;
  replyWithChatAction: ReturnType<typeof vi.fn>;
}

function makeCtx(overrides?: Partial<FakeCtx>): FakeCtx {
  return {
    chat: { id: 777 },
    match: "",
    message: { text: "hi" },
    reply: vi.fn(async () => undefined),
    replyWithDocument: vi.fn(async () => undefined),
    replyWithChatAction: vi.fn(async () => true),
    ...overrides,
  };
}

describe("inbound coalescing (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("three fragments within the window produce ONE agent.chat call with newline-joined text, threaded to the last fragment", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getMessageText(bot);
    const ctxA = makeCtx({ message: { text: "one", message_id: 11 } });
    const ctxB = makeCtx({ message: { text: "two", message_id: 12 } });
    const ctxC = makeCtx({ message: { text: "three", message_id: 13 } });

    await handler(ctxA);
    await handler(ctxB);
    await handler(ctxC);
    expect(agent.chat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();

    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "one\ntwo\nthree", undefined);

    // The flushed answer threads to the LAST fragment's message id, on the
    // last fragment's reply context.
    const htmlCall = ctxC.reply.mock.calls.find(
      (c: unknown[]) => (c[1] as { parse_mode?: string } | undefined)?.parse_mode === "HTML",
    );
    expect(htmlCall).toBeDefined();
    expect((htmlCall![1] as { reply_parameters?: { message_id?: number } }).reply_parameters).toEqual(
      { message_id: 13, allow_sending_without_reply: true },
    );
  });

  it("each fragment resets the timer: nothing fires until the window elapses after the LAST fragment", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "a" } }));
    await vi.advanceTimersByTimeAsync(1_000);
    await handler(makeCtx({ message: { text: "b" } }));
    await vi.advanceTimersByTimeAsync(1_000);
    await handler(makeCtx({ message: { text: "c" } }));

    // 100ms short of the window after the last fragment: still buffered.
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS - 100);
    expect(agent.chat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await drainPending();
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "a\nb\nc", undefined);
  });

  it("different chats are isolated: concurrent fragments never cross-join", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ chat: { id: 1 }, message: { text: "left" } }));
    await handler(makeCtx({ chat: { id: 2 }, message: { text: "right" } }));
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();

    expect(agent.chat).toHaveBeenCalledTimes(2);
    expect(agent.chat).toHaveBeenCalledWith("telegram:1", "left", undefined);
    expect(agent.chat).toHaveBeenCalledWith("telegram:2", "right", undefined);
  });

  it("a slash update mid-buffer flushes the pending text BEFORE the command handler runs", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "pending thought" } }));
    expect(agent.chat).not.toHaveBeenCalled();

    const next = vi.fn(async () => undefined);
    await getFlushMiddleware(bot)(makeCtx({ message: { text: "/status" } }), next);

    expect(next).toHaveBeenCalledTimes(1);
    // The buffered turn is dispatched (reaches agent.chat) before the command
    // handler chain continues — it enqueues on the FIFO session lock first.
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(agent.chat.mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0]);

    await drainPending();
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "pending thought", undefined);

    // The flush cleared the debounce timer: the window elapsing later must not
    // double-dispatch the same buffered text.
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS * 2);
    expect(agent.chat).toHaveBeenCalledTimes(1);
  });

  it("registration order: auth use → flush middleware use → every command", async () => {
    const { bot } = await buildBot();
    expect(bot.use).toHaveBeenCalledTimes(2);
    const authOrder = bot.use.mock.invocationCallOrder[0];
    const flushOrder = bot.use.mock.invocationCallOrder[1];
    expect(authOrder).toBeLessThan(flushOrder);
    expect(bot.command.mock.invocationCallOrder.length).toBeGreaterThan(0);
    for (const commandOrder of bot.command.mock.invocationCallOrder) {
      expect(flushOrder).toBeLessThan(commandOrder);
    }
  });

  it("drainPending flushes buffered text immediately — no debounce-timer wait", async () => {
    const { bot, agent, drainPending } = await buildBot();
    await getMessageText(bot)(makeCtx({ message: { text: "about to shut down" } }));
    expect(agent.chat).not.toHaveBeenCalled();

    // No timer advance: the drain itself must flush, then await the turn.
    await drainPending();
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "about to shut down", undefined);
  });

  it("each fragment fires one best-effort typing action during the window; the flushed turn still heartbeats", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getMessageText(bot);
    const ctxA = makeCtx({ message: { text: "one" } });
    const ctxB = makeCtx({ message: { text: "two" } });
    const ctxC = makeCtx({ message: { text: "three" } });

    await handler(ctxA);
    await handler(ctxB);
    await handler(ctxC);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctxA.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctxB.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctxC.replyWithChatAction).toHaveBeenCalledWith("typing");
    expect(ctxA.replyWithChatAction).toHaveBeenCalledTimes(1);
    expect(ctxB.replyWithChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();
    expect(agent.chat).toHaveBeenCalledTimes(1);
    // The heartbeat runs on the LAST fragment's rebound context.
    expect(ctxC.replyWithChatAction.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a typing-action failure never breaks the handler or the buffered turn", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const ctx = makeCtx({ message: { text: "hello" } });
    ctx.replyWithChatAction.mockRejectedValue(new Error("chat action down"));

    await expect(getMessageText(bot)(ctx)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "hello", undefined);
  });

  it("leading-slash message:text (unregistered command fallthrough) is never buffered", async () => {
    const { bot, agent, drainPending } = await buildBot();
    const handler = getMessageText(bot);

    await handler(makeCtx({ message: { text: "a buffered thought" } }));
    await handler(makeCtx({ message: { text: "/unknowncmd" } }));

    // The slash turn dispatched immediately — no window wait, no coalescing
    // with the pending free-form fragment.
    expect(agent.chat).toHaveBeenCalledTimes(1);
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "/unknowncmd", undefined);

    await vi.advanceTimersByTimeAsync(CHAT_COALESCE_MS);
    await drainPending();
    expect(agent.chat).toHaveBeenCalledTimes(2);
    expect(agent.chat).toHaveBeenCalledWith("telegram:777", "a buffered thought", undefined);
  });
});

describe("inbound coalescing (timer plumbing)", () => {
  it("debounce timers are unref'd; a reset clears exactly the previous timer", async () => {
    const { bot } = await buildBot();
    const handler = getMessageText(bot);

    const unrefA = vi.fn();
    const unrefB = vi.fn();
    const timers = [{ unref: unrefA }, { unref: unrefB }];
    const setTimeoutSpy = vi.fn(() => timers[setTimeoutSpy.mock.calls.length - 1]);
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("setTimeout", setTimeoutSpy);
    vi.stubGlobal("clearTimeout", clearTimeoutSpy);
    try {
      await handler(makeCtx({ message: { text: "first" } }));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(unrefA).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      await handler(makeCtx({ message: { text: "second" } }));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
      expect(unrefB).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timers[0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
