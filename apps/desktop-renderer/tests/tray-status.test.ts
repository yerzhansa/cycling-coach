import { describe, expect, it } from "vitest";
import { presentTrayTelegramStatus } from "../src/tray-status.js";

describe("tray Telegram status", () => {
  it.each([
    ["online", "Connected to Telegram", "active"],
    ["offline-retrying", "Telegram is reconnecting", "warning"],
    ["conflict", "Another poller owns the bot", "failed"],
    ["invalid-token", "Telegram token rejected", "failed"],
    ["transfer-required", "Bot transfer required", "failed"],
    ["failed", "Telegram needs attention", "failed"],
  ] as const)("projects %s", (channelState, copy, tone) => {
    expect(presentTrayTelegramStatus({ channelState, gapWarning: false })).toMatchObject({
      copy,
      tone,
    });
  });

  it("gives a possible delivery gap precedence over channel health", () => {
    expect(presentTrayTelegramStatus({ channelState: "online", gapWarning: true })).toEqual({
      copy: "Check for missed messages",
      tag: "warning",
      tone: "warning",
    });
  });

  it("presents transient sleep suspension without calling Telegram off", () => {
    expect(presentTrayTelegramStatus({ channelState: "suspended", gapWarning: false })).toEqual({
      copy: "Telegram is paused while this Mac sleeps",
      tag: "paused",
      tone: "idle",
    });
  });
});
