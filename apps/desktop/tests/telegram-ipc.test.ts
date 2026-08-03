import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_TELEGRAM_DISABLE_CHANNEL,
  DESKTOP_TELEGRAM_ENABLE_CHANNEL,
  DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_CHANNEL,
  DESKTOP_TELEGRAM_STATUS_CHANNEL,
} from "../src/main/constants.js";
import { installDesktopTelegramIpc } from "../src/main/telegram-ipc.js";

const STATUS = Object.freeze({ desiredState: "disabled", state: "disabled" } as const);

function setup(options: { readonly trusted?: boolean; readonly configured?: boolean } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  const trace: string[] = [];
  let configured = options.configured ?? false;
  const coordinator = {
    status: vi.fn(async () => ({ ...STATUS, token: "private" })),
    configure: vi.fn(async (token: string) => {
      trace.push(`configure:${token}`);
      configured = true;
      return STATUS;
    }),
    replace: vi.fn(async (token: string) => {
      trace.push(`replace:${token}`);
      return STATUS;
    }),
    enable: vi.fn(async () => ({ desiredState: "enabled", state: "starting" }) as const),
    disable: vi.fn(async () => STATUS),
    remove: vi.fn(async () => STATUS),
    reconcile: vi.fn(async () => STATUS),
  };
  const vault = {
    credentialStatus: vi.fn(
      async () => ({ state: configured ? "configured" : "missing" }) as const,
    ),
  };
  const clipboard = {
    readText: vi.fn(() => {
      trace.push("read");
      return "  123456:synthetic-token  ";
    }),
    clear: vi.fn(() => {
      trace.push("clear");
    }),
  };
  const dispose = installDesktopTelegramIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as never),
      removeHandler: (channel) => removed.push(channel),
    },
    clipboard,
    coordinator,
    vault,
    isTrusted: () => options.trusted ?? true,
  });
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: {}, senderFrame: {} }, ...args);
  return { clipboard, coordinator, dispose, handlers, invoke, removed, trace, vault };
}

describe("Desktop Telegram IPC", () => {
  it("registers only the six semantic control handlers and removes them", () => {
    const runtime = setup();
    expect([...runtime.handlers.keys()].sort()).toEqual(
      [
        DESKTOP_TELEGRAM_STATUS_CHANNEL,
        DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
        DESKTOP_TELEGRAM_ENABLE_CHANNEL,
        DESKTOP_TELEGRAM_DISABLE_CHANNEL,
        DESKTOP_TELEGRAM_REMOVE_CHANNEL,
        DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
      ].sort(),
    );
    runtime.dispose();
    expect(runtime.removed.sort()).toEqual([...runtime.handlers.keys()].sort());
  });

  it("projects only closed metadata and adds configured state", async () => {
    const runtime = setup({ configured: true });
    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      desiredState: "disabled",
      state: "disabled",
      credentialConfigured: true,
    });
  });

  it("reads and clears the clipboard synchronously before selecting configure", async () => {
    const runtime = setup();
    const pending = runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);
    expect(runtime.trace).toEqual(["read", "clear"]);
    await expect(pending).resolves.toMatchObject({ credentialConfigured: true });
    expect(runtime.trace).toEqual(["read", "clear", "configure:123456:synthetic-token"]);
    expect(runtime.coordinator.replace).not.toHaveBeenCalled();
  });

  it("atomically selects replacement when a credential already exists", async () => {
    const runtime = setup({ configured: true });
    await runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);
    expect(runtime.coordinator.configure).not.toHaveBeenCalled();
    expect(runtime.coordinator.replace).toHaveBeenCalledWith("123456:synthetic-token");
  });

  it("clears on clipboard failure and never invokes a token operation", async () => {
    const runtime = setup();
    runtime.clipboard.readText.mockImplementationOnce(() => {
      runtime.trace.push("read-failed");
      throw new Error("private clipboard detail");
    });
    await expect(runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-control-failed",
      credentialConfigured: false,
    });
    expect(runtime.clipboard.clear).toHaveBeenCalledOnce();
    expect(runtime.coordinator.configure).not.toHaveBeenCalled();
    expect(runtime.coordinator.replace).not.toHaveBeenCalled();
  });

  it("rejects malformed clipboard text before storing it", async () => {
    const runtime = setup({ configured: true });
    runtime.clipboard.readText.mockReturnValueOnce("invalid token with spaces");

    await expect(runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toMatchObject({
      state: "failed",
      credentialConfigured: true,
    });

    expect(runtime.clipboard.clear).toHaveBeenCalledOnce();
    expect(runtime.coordinator.configure).not.toHaveBeenCalled();
    expect(runtime.coordinator.replace).not.toHaveBeenCalled();
  });

  it("rejects untrusted and non-zero-argument calls before clipboard access", async () => {
    const untrusted = setup({ trusted: false });
    expect(() => untrusted.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).toThrow(
      "untrusted desktop Telegram request",
    );
    const extra = setup();
    expect(() => extra.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL, "token")).toThrow(
      TypeError,
    );
    expect(extra.clipboard.readText).not.toHaveBeenCalled();
    expect(extra.clipboard.clear).not.toHaveBeenCalled();
  });
});
