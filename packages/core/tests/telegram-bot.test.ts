import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import {
  defaultPairingState,
  saveAllowedSenders,
} from "../src/channels/allowed-senders.js";
import { GARMIN_DATA_ATTRIBUTION } from "../src/agent/garmin-attribution.js";

let dataDir: string;
const ENV_KEYS = [
  "CYCLING_COACH_OPERATOR_ID",
  "CYCLING_COACH_DM_POLICY",
  "CYCLING_COACH_MANAGED_DEPLOY",
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-tg-bot-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("grammy");
  vi.doUnmock("../src/updater.js");
  vi.doUnmock("../src/channels/allowed-senders.js");
});

function seedSession(chatId: string): void {
  writeFileSync(
    join(dataDir, "sessions", `telegram:${chatId}.jsonl`),
    JSON.stringify({ role: "user", content: "x", ts: Date.now() }),
  );
}

function installTelegramBotMock() {
  const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const onHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const bot = {
    api: {
      setMyCommands: vi.fn(async () => true),
      config: { use: vi.fn() },
    },
    use: vi.fn(),
    command: vi.fn((name: string, handler: (ctx: unknown) => Promise<void>) => {
      commandHandlers.set(name, handler);
    }),
    on: vi.fn((name: string, handler: (ctx: unknown) => Promise<void>) => {
      onHandlers.set(name, handler);
    }),
    catch: vi.fn(),
  };
  class FakeInputFile {
    constructor(
      readonly data: Buffer,
      readonly filename: string,
    ) {}
  }
  class FakeGrammyError extends Error {}
  vi.doMock("grammy", () => ({
    Bot: function FakeBot() {
      return bot;
    },
    InputFile: FakeInputFile,
    GrammyError: FakeGrammyError,
  }));
  return { bot, commandHandlers, onHandlers };
}

describe("createTelegramBot — Garmin attribution carriage", () => {
  it("delivers /status attribution and resends the identical attributed answer", async () => {
    const { commandHandlers, onHandlers } = installTelegramBotMock();
    const attributedAnswer = `Fitness is steady.\n\n${GARMIN_DATA_ATTRIBUTION}`;
    const agent = {
      chat: vi.fn(async () => attributedAnswer),
      resetSession: vi.fn(),
      hasSession: vi.fn(() => true),
      confirmations: { peek: vi.fn(), confirm: vi.fn(), cancel: vi.fn() },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const handle = createTelegramBot(
      "FAKE_TOKEN",
      agent as unknown as Parameters<typeof createTelegramBot>[1],
      cyclingBinary,
      dataDir,
    );
    const replies: string[] = [];
    const ctx = {
      chat: { id: 73 },
      message: { text: "/status", message_id: 10 },
      reply: vi.fn(async (text: string) => {
        replies.push(text);
      }),
      replyWithChatAction: vi.fn(async () => undefined),
    };

    await commandHandlers.get("status")!(ctx);
    await handle.drainPending();

    expect(agent.chat).toHaveBeenCalledWith("telegram:73", "/status", undefined);
    expect(replies).toContain(attributedAnswer);

    ctx.message = { text: "resend", message_id: 11 };
    await onHandlers.get("message:text")!(ctx);
    await handle.drainPending();

    expect(agent.chat).toHaveBeenCalledOnce();
    expect(replies.filter((text) => text === attributedAnswer)).toHaveLength(2);
  });

  it("passes the exact attribution as a raw-snapshot document caption", async () => {
    const { commandHandlers } = installTelegramBotMock();
    const agent = {
      chat: vi.fn(),
      resetSession: vi.fn(),
      hasSession: vi.fn(),
      confirmations: { peek: vi.fn(), confirm: vi.fn(), cancel: vi.fn() },
    };
    const reference = {
      runSync: vi.fn(),
      maybeRefreshIfStale: vi.fn(async () => ({ kind: "fresh" as const })),
      loadLatest: vi.fn(() => ({
        metadata: {
          schema_version: "1",
          last_updated: "1999-04-03T10:00:00Z",
          freshness: "fresh",
        },
        athlete_profile: { id: "synthetic-athlete" },
        current_status: {},
        derived_metrics: { padding: "x".repeat(70_000) },
        recent_activities: [],
        planned_workouts: [],
        wellness_data: {},
      })),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { createTelegramBot } = await import("../src/channels/telegram.js");
    createTelegramBot(
      "FAKE_TOKEN",
      agent as unknown as Parameters<typeof createTelegramBot>[1],
      cyclingBinary,
      dataDir,
      reference as unknown as Parameters<typeof createTelegramBot>[4],
    );
    const replyWithDocument = vi.fn(
      async (_file: unknown, _options?: { caption?: string }) => undefined,
    );
    const ctx = {
      match: "raw",
      chat: { id: 73 },
      reply: vi.fn(async () => undefined),
      replyWithDocument,
    };

    await commandHandlers.get("snapshot")!(ctx);

    expect(replyWithDocument).toHaveBeenCalledOnce();
    expect(replyWithDocument.mock.calls[0]![1]).toEqual({ caption: GARMIN_DATA_ATTRIBUTION });
  });
});

describe("notifyUpdate — broadcast filtering (L3)", () => {
  it("filters chat-ids to allowFrom subset (allowlist mode)", async () => {
    seedSession("11111"); // allowed
    seedSession("22222"); // allowed
    seedSession("99999"); // stranger from before allowlist
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["11111", "22222"],
      primaryOperator: "11111",
    }));

    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>(
        "../src/updater.js",
      );
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        getKnownTelegramChatIds: vi.fn(() => ["11111", "22222", "99999"]),
        getLastNotifiedVersion: vi.fn(() => null),
        setLastNotifiedVersion: vi.fn(),
      };
    });

    const sendMessage = vi.fn(async (_chatId: string, _message: string) => undefined);
    const fakeBot = { api: { sendMessage } } as unknown as Parameters<
      typeof import("../src/channels/telegram.js")["notifyUpdate"]
    >[0];

    const { notifyUpdate } = await import("../src/channels/telegram.js");
    await notifyUpdate(fakeBot, dataDir, cyclingBinary);

    const calledIds = sendMessage.mock.calls.map((c: unknown[]) => String(c[0])).sort();
    expect(calledIds).toEqual(["11111", "22222"]);
    expect(calledIds).not.toContain("99999");
  });

  // The daily re-check calls notifyUpdate on a timer; the last-notified-version
  // guard must make a second firing for the same version a no-op so athletes get
  // at most one broadcast per release.
  it("does not re-broadcast an already-notified version on a second firing (idempotent)", async () => {
    seedSession("11111");
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["11111"],
      primaryOperator: "11111",
    }));

    // Keep the REAL getLastNotifiedVersion / setLastNotifiedVersion so the
    // guard actually persists to (and reads back from) the temp data dir.
    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>(
        "../src/updater.js",
      );
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        getKnownTelegramChatIds: vi.fn(() => ["11111"]),
      };
    });

    const sendMessage = vi.fn(async (_chatId: string, _message: string) => undefined);
    const fakeBot = { api: { sendMessage } } as unknown as Parameters<
      typeof import("../src/channels/telegram.js")["notifyUpdate"]
    >[0];

    const { notifyUpdate } = await import("../src/channels/telegram.js");
    await notifyUpdate(fakeBot, dataDir, cyclingBinary);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await notifyUpdate(fakeBot, dataDir, cyclingBinary);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("broadcasts to all known chats when CYCLING_COACH_DM_POLICY=open (env-var-only escape)", async () => {
    seedSession("11111");
    seedSession("99999");
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["11111"],
      primaryOperator: "11111",
    }));
    process.env.CYCLING_COACH_DM_POLICY = "open";

    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>(
        "../src/updater.js",
      );
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        getKnownTelegramChatIds: vi.fn(() => ["11111", "99999"]),
        getLastNotifiedVersion: vi.fn(() => null),
        setLastNotifiedVersion: vi.fn(),
      };
    });

    const sendMessage = vi.fn(async (_chatId: string, _message: string) => undefined);
    const fakeBot = { api: { sendMessage } } as unknown as Parameters<
      typeof import("../src/channels/telegram.js")["notifyUpdate"]
    >[0];

    const { notifyUpdate } = await import("../src/channels/telegram.js");
    await notifyUpdate(fakeBot, dataDir, cyclingBinary);

    const calledIds = sendMessage.mock.calls.map((c: unknown[]) => String(c[0])).sort();
    expect(calledIds).toEqual(["11111", "99999"]);
  });

  it("does NOT broadcast in default-pairing mode (no allowed senders → empty filter)", async () => {
    seedSession("99999");

    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>(
        "../src/updater.js",
      );
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        getKnownTelegramChatIds: vi.fn(() => ["99999"]),
        getLastNotifiedVersion: vi.fn(() => null),
        setLastNotifiedVersion: vi.fn(),
      };
    });

    const sendMessage = vi.fn(async (_chatId: string, _message: string) => undefined);
    const fakeBot = { api: { sendMessage } } as unknown as Parameters<
      typeof import("../src/channels/telegram.js")["notifyUpdate"]
    >[0];

    const { notifyUpdate } = await import("../src/channels/telegram.js");
    await notifyUpdate(fakeBot, dataDir, cyclingBinary);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("managed deploy broadcast points at image redeploys instead of /update", async () => {
    seedSession("11111");
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["11111"],
      primaryOperator: "11111",
    }));
    process.env.CYCLING_COACH_MANAGED_DEPLOY = "1";

    vi.doMock("../src/updater.js", async () => {
      const real = await vi.importActual<typeof import("../src/updater.js")>(
        "../src/updater.js",
      );
      return {
        ...real,
        checkForUpdate: vi.fn(async () => ({
          current: "2026.5.5",
          latest: "2026.5.10",
          updateAvailable: true,
        })),
        getKnownTelegramChatIds: vi.fn(() => ["11111"]),
        getLastNotifiedVersion: vi.fn(() => null),
        setLastNotifiedVersion: vi.fn(),
      };
    });

    const sendMessage = vi.fn(async (_chatId: string, _message: string) => undefined);
    const fakeBot = { api: { sendMessage } } as unknown as Parameters<
      typeof import("../src/channels/telegram.js")["notifyUpdate"]
    >[0];

    const { notifyUpdate } = await import("../src/channels/telegram.js");
    await notifyUpdate(fakeBot, dataDir, cyclingBinary);

    const message = sendMessage.mock.calls[0]?.[1] ?? "";
    expect(message).toContain("Update available: 2026.5.5");
    expect(message).toContain("Send /whatsnew to see what changed.");
    expect(message).toContain("container image");
    expect(message).toContain("GHCR image");
    expect(message).toContain("Railway");
    expect(message).not.toContain("/update to install");
    expect(message).toContain(
      "Want the bot running 24/7 without keeping your computer on? Deploy the Railway template: https://railway.com/deploy/cycling-coach",
    );
    expect(message).toContain("https://tally.so/r/b5Dv4g");
    expect(message).toContain("Help shape what Cycling Coach builds next");
    expect(message).not.toContain("x.com/yerzhansa");
    expect(message.indexOf("https://tally.so/r/b5Dv4g")).toBeLessThan(
      message.indexOf("railway.com/deploy/cycling-coach"),
    );
  });
});

describe("createTelegramBot — startup diagnostic + no security broadcast", () => {
  it("REGRESSION (CRITICAL): startup with no allowed-senders.json does NOT call bot.api.sendMessage", async () => {
    // Mock grammy.Bot so we can spy on sendMessage and avoid network calls.
    const sendMessage = vi.fn(async () => undefined);
    const use = vi.fn();
    const command = vi.fn();
    const on = vi.fn();
    const bot = {
      api: { sendMessage, setMyCommands: vi.fn(async () => true), config: { use: vi.fn() } },
      use,
      command,
      on,
      catch: vi.fn(),
    };

    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
    }));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = {
      chat: vi.fn(),
      resetSession: vi.fn(),
      hasSession: vi.fn(),
      confirmations: { peek: vi.fn(), confirm: vi.fn(), cancel: vi.fn() },
    };

    const { createTelegramBot } = await import("../src/channels/telegram.js");
    const result = createTelegramBot(
      "FAKE_TOKEN",
      agent as unknown as Parameters<typeof createTelegramBot>[1],
      cyclingBinary,
      dataDir,
    );
    expect(result.bot).toBe(bot);

    // No bot.api.sendMessage anywhere in createTelegramBot — security info goes
    // to stderr only (the operator-constraint).
    expect(sendMessage).not.toHaveBeenCalled();
    // Auth middleware is registered first.
    expect(use).toHaveBeenCalled();
    expect(on).toHaveBeenCalledWith("callback_query:data", expect.any(Function));
    // Diagnostic stderr logging fired.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[security\] Telegram allowlist: pairing mode/),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/No allowed senders configured.*cycling-coach add-sender/),
    );
    errSpy.mockRestore();
  });

  it("startup diagnostic logs primary operator id when allowed-senders.json exists", async () => {
    saveAllowedSenders(dataDir, () => ({
      ...defaultPairingState(),
      dmPolicy: "allowlist",
      allowFrom: ["12345"],
      primaryOperator: "12345",
    }));

    const sendMessage = vi.fn(async () => undefined);
    const bot = {
      api: { sendMessage, setMyCommands: vi.fn(async () => true), config: { use: vi.fn() } },
      use: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
      catch: vi.fn(),
    };
    vi.doMock("grammy", () => ({
      Bot: function FakeBot() {
        return bot;
      },
    }));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = { chat: vi.fn(), resetSession: vi.fn(), hasSession: vi.fn() };
    const { createTelegramBot } = await import("../src/channels/telegram.js");
    createTelegramBot(
      "FAKE",
      agent as unknown as Parameters<typeof createTelegramBot>[1],
      cyclingBinary,
      dataDir,
    );

    const allLogs = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toMatch(/\[security\] Telegram allowlist: allowlist mode \(1 allowed senders, primary: 12345\)/);
    expect(allLogs).not.toMatch(/No allowed senders configured/);
    errSpy.mockRestore();
  });
});
