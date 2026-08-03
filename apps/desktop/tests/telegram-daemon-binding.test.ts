import type { AthleteHomeIdentity } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDaemonBinding } from "../src/main/telegram-daemon-binding.js";

const HOME = "/synthetic/athlete" as AthleteHomeIdentity;

describe("Telegram daemon binding", () => {
  it("binds one generation and closes each privileged client after a call", async () => {
    const close = vi.fn(async () => undefined);
    const call = vi.fn(async () => ({ desiredState: "disabled", state: "disabled" }));
    const connect = vi.fn(async () => ({ call, close }));
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

    await binding.getTelegramStatus({});

    expect(binding).toMatchObject({
      generation: 4,
      athleteHome: HOME,
      supervision: "app-supervised",
    });
    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:43123/rpc",
      token: "privileged-token",
      expectedAthleteHome: HOME,
    });
    expect(call).toHaveBeenCalledWith("getTelegramStatus", {});
    expect(close).toHaveBeenCalledOnce();
    expect(Object.isFrozen(binding)).toBe(true);
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
