import { describe, expect, it } from "vitest";
import { CodexAgentConfigError } from "@enduragent/engine";

import { runCodexAgentStartupGate } from "../src/codex-agent-startup.js";
import {
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_WINDOWS_MESSAGE,
} from "../src/runtime-config.js";

function collector(): { lines: string[]; refusals: string[] } {
  return { lines: [], refusals: [] };
}

function readyReport() {
  return {
    status: "ready" as const,
    binaryPath: "/opt/synthetic/bin/codex",
    version: "0.146.0",
    account: { type: "chatgpt" as const, email: "rider@example.test", planType: "pro" },
    identityLine: "Signed in as rider@example.test - ChatGPT Pro plan",
    foreignServers: [] as readonly string[],
    models: ["gpt-5.6-sol"] as readonly string[],
    warnings: [] as readonly string[],
  };
}

describe("codex-agent startup gate", () => {
  it("refuses on windows before any binary resolution or enablement check", async () => {
    const sink = collector();
    const result = await runCodexAgentStartupGate(
      { settings: { enabled: true }, model: "gpt-5.6-sol" },
      {
        platform: "win32",
        ensureReady: async () => {
          throw new Error("probe must not run on win32");
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(result).toBeNull();
    expect(sink.refusals).toEqual([CODEX_AGENT_WINDOWS_MESSAGE]);
    expect(sink.lines).toEqual([]);
  });

  it("refuses when the lane was never enabled", async () => {
    const sink = collector();
    const result = await runCodexAgentStartupGate(
      { settings: { enabled: false }, model: "gpt-5.6-sol" },
      {
        platform: "darwin",
        ensureReady: async () => {
          throw new Error("probe must not run when disabled");
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(result).toBeNull();
    expect(sink.refusals).toEqual([CODEX_AGENT_DISABLED_MESSAGE]);
  });

  it("refuses when the block is absent entirely", async () => {
    const sink = collector();
    await runCodexAgentStartupGate(
      { settings: undefined, model: "gpt-5.6-sol" },
      {
        platform: "linux",
        ensureReady: async () => {
          throw new Error("probe must not run when the block is absent");
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(sink.refusals).toEqual([CODEX_AGENT_DISABLED_MESSAGE]);
  });

  it("logs the identity line on a verified chatgpt sign-in", async () => {
    const sink = collector();
    const result = await runCodexAgentStartupGate(
      {
        settings: { enabled: true, binaryPath: "/opt/synthetic/bin/codex" },
        model: "gpt-5.6-sol",
      },
      {
        platform: "darwin",
        ensureReady: async (input) => {
          expect(input.binaryPath).toBe("/opt/synthetic/bin/codex");
          expect(input.model).toBe("gpt-5.6-sol");
          return readyReport();
        },
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(sink.refusals).toEqual([]);
    expect(sink.lines).toEqual(["Signed in as rider@example.test - ChatGPT Pro plan"]);
    expect(result?.version).toBe("0.146.0");
  });

  it("refuses with the taxonomy message when the probe returns a refusal", async () => {
    const sink = collector();
    const result = await runCodexAgentStartupGate(
      { settings: { enabled: true }, model: "gpt-5.6-sol" },
      {
        platform: "darwin",
        ensureReady: async () => ({
          status: "refused" as const,
          error: new CodexAgentConfigError("not-signed-in", "codex is not signed in"),
        }),
        log: (line) => sink.lines.push(line),
        refuse: (message) => sink.refusals.push(message),
      },
    );
    expect(result).toBeNull();
    expect(sink.refusals).toEqual(["codex is not signed in"]);
    expect(sink.lines).toEqual([]);
  });

  it("refuses on an unexpected probe failure instead of serving", async () => {
    const sink = collector();
    await runCodexAgentStartupGate(
      { settings: { enabled: true }, model: "gpt-5.6-sol" },
      {
        platform: "darwin",
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
