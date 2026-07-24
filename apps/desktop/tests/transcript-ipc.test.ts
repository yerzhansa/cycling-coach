import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoachClientCallTimeoutError } from "@enduragent/coach-client";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import {
  createConnectionTranscriptReader,
  installDesktopTranscriptIpc,
} from "../src/main/transcript-ipc.js";
import { DESKTOP_RENDERER_URL, DESKTOP_TRANSCRIPT_PAGE_CHANNEL } from "../src/main/constants.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const page = {
  schemaVersion: 1 as const,
  status: "page" as const,
  turns: [
    {
      turnId: "turn-1",
      completedAt: "1998-07-06T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    },
  ],
  nextCursor: null,
};

function setup(readPage = vi.fn(async () => page)) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame = { url: DESKTOP_RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const dispose = installDesktopTranscriptIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => window as never,
    readPage,
  });
  return {
    dispose,
    handlers,
    ipcMain,
    readPage,
    trusted: { sender: webContents, senderFrame: mainFrame },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("desktop transcript IPC", () => {
  it("forwards one strict request from the trusted main frame and returns a parsed copy", async () => {
    const subject = setup();
    const handler = subject.handlers.get(DESKTOP_TRANSCRIPT_PAGE_CHANNEL)!;
    const result = await handler(subject.trusted, { cursor: null, limit: 25 });

    expect(result).toEqual(page);
    expect(result).not.toBe(page);
    expect(subject.readPage).toHaveBeenCalledWith({ cursor: null, limit: 25 });
  });

  it("refuses untrusted and malformed requests before invoking the daemon reader", async () => {
    const subject = setup();
    const handler = subject.handlers.get(DESKTOP_TRANSCRIPT_PAGE_CHANNEL)!;
    await expect(
      handler(
        { sender: {}, senderFrame: { url: DESKTOP_RENDERER_URL } },
        { cursor: null, limit: 25 },
      ),
    ).rejects.toThrow("untrusted desktop transcript request");

    for (const args of [
      [],
      [{ cursor: null, limit: 0 }],
      [{ cursor: null, limit: 51 }],
      [{ cursor: null, limit: 25, chatId: "other" }],
      [{ cursor: "a".repeat(152), limit: 25 }],
      [{ cursor: null, limit: 25 }, { extra: true }],
    ]) {
      await expect(handler(subject.trusted, ...args)).rejects.toThrow(
        "invalid desktop transcript request",
      );
    }
    expect(subject.readPage).not.toHaveBeenCalled();
  });

  it("redacts deadline failures and malformed daemon responses", async () => {
    const timeout = setup(
      vi.fn(async () => {
        throw new CoachClientCallTimeoutError("getTranscriptPage", 30_000);
      }),
    );
    const timeoutHandler = timeout.handlers.get(DESKTOP_TRANSCRIPT_PAGE_CHANNEL)!;
    await expect(timeoutHandler(timeout.trusted, { cursor: null, limit: 25 })).rejects.toThrow(
      "desktop transcript unavailable",
    );

    const malformed = setup(
      vi.fn(async () => ({
        ...page,
        transcriptPath: "/synthetic/private/transcript",
      })),
    );
    const malformedHandler = malformed.handlers.get(DESKTOP_TRANSCRIPT_PAGE_CHANNEL)!;
    await expect(malformedHandler(malformed.trusted, { cursor: null, limit: 25 })).rejects.toThrow(
      "desktop transcript unavailable",
    );
  });

  it("uses a terminal deadline-aware coach client and closes it after each read", async () => {
    const client = {
      call: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const connect = vi.fn(async () => client);
    const reader = createConnectionTranscriptReader(
      {
        url: "ws://127.0.0.1:45001/rpc",
        token: "s".repeat(43),
      },
      connect as never,
    );

    await expect(reader.getTranscriptPage({ cursor: null, limit: 25 })).resolves.toEqual(page);
    expect(client.call).toHaveBeenCalledWith("getTranscriptPage", {
      cursor: null,
      limit: 25,
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("removes the transcript channel during shutdown", () => {
    const subject = setup();
    subject.dispose();
    expect(subject.handlers.has(DESKTOP_TRANSCRIPT_PAGE_CHANNEL)).toBe(false);
    expect(subject.ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_TRANSCRIPT_PAGE_CHANNEL);
  });
});
