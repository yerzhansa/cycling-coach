import { describe, expect, it } from "vitest";
import {
  isUtilityShutdownFrame,
  isUtilityStartFrame,
  isUtilityTerminalAckFrame,
  isUtilityTerminalFrame,
  createUtilityEnvironment,
} from "../src/main/supervisor.js";

describe("desktop utility protocol", () => {
  it("accepts only strict start and shutdown control frames", () => {
    expect(isUtilityStartFrame({ type: "start", homeRoot: "/synthetic/athlete" })).toBe(true);
    expect(
      isUtilityStartFrame({
        type: "start",
        homeRoot: "/synthetic/athlete",
        handoffCapability: "a".repeat(43),
      }),
    ).toBe(true);
    for (const frame of [
      { type: "start", homeRoot: "relative" },
      { type: "start", homeRoot: "/synthetic/athlete", extra: true },
      { type: "start", homeRoot: "/synthetic/athlete", handoffCapability: "short" },
      { type: "unknown" },
    ])
      expect(isUtilityStartFrame(frame)).toBe(false);
    expect(isUtilityShutdownFrame({ type: "shutdown" })).toBe(true);
    expect(isUtilityShutdownFrame({ type: "shutdown", extra: true })).toBe(false);
  });

  it("accepts only strict terminal and acknowledgement frames", () => {
    expect(isUtilityTerminalFrame({ type: "terminal", exitCode: 0 })).toBe(true);
    expect(isUtilityTerminalFrame({ type: "terminal", exitCode: -1 })).toBe(false);
    expect(isUtilityTerminalFrame({ type: "terminal", exitCode: 0, extra: true })).toBe(false);
    expect(isUtilityTerminalAckFrame({ type: "terminal-ack" })).toBe(true);
    expect(isUtilityTerminalAckFrame({ type: "terminal-ack", extra: true })).toBe(false);
  });

  it("removes daemon ownership material from the utility environment", () => {
    expect(
      createUtilityEnvironment({
        PATH: "/synthetic/bin",
        ENDURAGENT_HOME: "/synthetic/athlete",
        ENDURAGENT_DAEMON_OWNER: "app-supervised",
        ENDURAGENT_HANDOFF_CAPABILITY: "a".repeat(43),
        ENDURAGENT_STARTER_CONTEXT_FD: "9",
      }),
    ).toEqual({ PATH: "/synthetic/bin" });
  });
});
