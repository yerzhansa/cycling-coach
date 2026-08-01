import { describe, expect, it } from "vitest";
import { ClaudeCliConfigError } from "@enduragent/engine";

import { runClaudeCliStartupGate } from "../src/claude-cli-startup.js";
import { CLAUDE_CLI_DISABLED_MESSAGE } from "../src/runtime-config.js";

function collector(): { lines: string[]; refusals: string[] } {
  return { lines: [], refusals: [] };
}

describe("claude-cli startup gate", () => {
  it("refuses when the kill switch disabled the lane", async () => {
    const sink = collector();
    const result = await runClaudeCliStartupGate(
      { settings: { enabled: false, billing: "subscription" }, model: "sonnet" },
      {
        ensureReady: async () => {
          throw new Error("probe must not run when disabled");
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(result).toBeNull();
    expect(sink.refusals).toEqual([CLAUDE_CLI_DISABLED_MESSAGE]);
  });

  it("logs the identity line on a verified subscription", async () => {
    const sink = collector();
    const result = await runClaudeCliStartupGate(
      {
        settings: { enabled: true, billing: "subscription", binaryPath: "/opt/bin/claude" },
        model: "sonnet",
      },
      {
        ensureReady: async (input) => {
          expect(input?.binaryPath).toBe("/opt/bin/claude");
          expect(input?.billing).toBe("subscription");
          expect(input?.model).toBe("sonnet");
          return {
            binaryPath: "/opt/bin/claude",
            version: "9.9.9",
            identityLine: "Signed in as rider@example.test - Claude Max subscription",
            accountClass: "subscription" as const,
          };
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(sink.refusals).toEqual([]);
    expect(sink.lines).toEqual(["Signed in as rider@example.test - Claude Max subscription"]);
    expect(result?.version).toBe("9.9.9");
  });

  it("refuses with the taxonomy message when the probe fails closed", async () => {
    const sink = collector();
    await runClaudeCliStartupGate(
      { settings: { enabled: true, billing: "subscription" }, model: "sonnet" },
      {
        ensureReady: async () => {
          throw new ClaudeCliConfigError("unrecognized-auth-source", "unrecognized auth taxonomy");
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(sink.refusals).toEqual(["unrecognized auth taxonomy"]);
    expect(sink.lines).toEqual([]);
  });

  it("refuses on an unexpected probe failure instead of serving", async () => {
    const sink = collector();
    await runClaudeCliStartupGate(
      { settings: undefined, model: "sonnet" },
      {
        ensureReady: async () => {
          throw new Error("spawn blew up");
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(sink.refusals).toHaveLength(1);
    expect(sink.refusals[0]).toContain("spawn blew up");
    expect(sink.lines).toEqual([]);
  });
});
