import type { AthleteHomeIdentity } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDaemonBinding } from "../src/main/telegram-daemon-binding.js";

const HOME = "/synthetic/athlete" as AthleteHomeIdentity;
const TOKEN = "123456:synthetic-token";

describe("Telegram daemon binding", () => {
  it("binds every privileged Telegram method to one authenticated generation", async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const call = vi.fn(async () => ({
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
    }));
    const connect = vi.fn(async () => {
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { call, close };
    });
    const binding = createTelegramDaemonBinding(
      {
        url: "ws://127.0.0.1:43123/rpc",
        token: "privileged-token",
        athleteHome: HOME,
        generation: 4,
        supervision: "app-supervised",
      },
      HOME,
      connect as never,
    );

    await binding.configureTelegram({ token: TOKEN });
    await binding.enableTelegram({});
    await binding.disableTelegram({});
    await binding.replaceTelegram({ token: TOKEN });
    await binding.getTelegramStatus({});
    await binding.reconcileTelegram({});
    await binding.inspectTelegramCredential({ token: TOKEN });
    await binding.deleteTelegramWebhook({ token: TOKEN });
    await binding.forgetTelegramCredential({});
    await binding.beginTelegramPairing({});
    await binding.cancelTelegramPairing({});
    await binding.listTelegramAllowedSenders({});
    await binding.addTelegramAllowedSender({ senderId: 12345 });
    await binding.removeTelegramAllowedSender({ senderId: 67890 });

    expect(binding).toMatchObject({
      generation: 4,
      athleteHome: HOME,
      supervision: "app-supervised",
    });
    expect(call.mock.calls).toEqual([
      ["configureTelegram", { token: TOKEN }],
      ["enableTelegram", {}],
      ["disableTelegram", {}],
      ["replaceTelegram", { token: TOKEN }],
      ["getTelegramStatus", {}],
      ["reconcileTelegram", {}],
      ["inspectTelegramCredential", { token: TOKEN }],
      ["deleteTelegramWebhook", { token: TOKEN }],
      ["forgetTelegramCredential", {}],
      ["beginTelegramPairing", {}],
      ["cancelTelegramPairing", {}],
      ["listTelegramAllowedSenders", {}],
      ["addTelegramAllowedSender", { senderId: 12345 }],
      ["removeTelegramAllowedSender", { senderId: 67890 }],
    ]);
    expect(connect).toHaveBeenCalledTimes(call.mock.calls.length);
    for (const invocation of connect.mock.calls) {
      expect(invocation).toEqual([
        {
          url: "ws://127.0.0.1:43123/rpc",
          token: "privileged-token",
          expectedAthleteHome: HOME,
        },
      ]);
    }
    expect(closes).toHaveLength(call.mock.calls.length);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("closes the privileged client when a daemon RPC rejects", async () => {
    const close = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({
      call: vi.fn(async () => {
        throw new Error("private daemon detail");
      }),
      close,
    }));
    const binding = createTelegramDaemonBinding(
      {
        url: "ws://127.0.0.1:43123/rpc",
        token: "privileged-token",
        athleteHome: HOME,
        generation: 1,
        supervision: "attached",
      },
      HOME,
      connect as never,
    );

    await expect(binding.beginTelegramPairing({})).rejects.toThrow("private daemon detail");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a different authenticated home before connecting", () => {
    const connect = vi.fn();
    expect(() =>
      createTelegramDaemonBinding(
        {
          url: "ws://127.0.0.1:43123/rpc",
          token: "privileged-token",
          athleteHome: "/synthetic/other",
          generation: 1,
          supervision: "attached",
        },
        HOME,
        connect as never,
      ),
    ).toThrow("desktop daemon home mismatch");
    expect(connect).not.toHaveBeenCalled();
  });
});
