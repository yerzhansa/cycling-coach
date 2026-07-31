import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CoachAgent } from "../src/agent/coach-agent.js";
import type { EngineHostPorts, MemoryStorePort } from "../src/host-ports.js";
import { EMPTY_PROVENANCE } from "../src/provenance.js";
import { Memory } from "../../core/src/memory/store.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-inject-wiring-"));
  roots.push(root);
  const dataDir = join(root, ".cycling-coach");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  return dataDir;
}

function seed(dataDir: string): void {
  const memory = new Memory(dataDir);
  memory.writeSection("person", "Name: Sam; weight 72kg");
  memory.writeSection("cycling-profile", "FTP 250W, max HR 188");
  memory.writeSection("notes", "prefers hill repeats, dislikes the trainer");
  memory.writeSection("cycling-equipment", "Canyon Ultimate, Kickr Core");
  memory.writeSection("cycling-history", "left knee tendinopathy in March");
  memory.writeSection("random-legacy", "stale orphan body not matching any spec");
}

async function capturedSystemPrompt(
  dataDir: string,
  memoryOverride?: MemoryStorePort,
): Promise<string> {
  const base = baseAgentConfig(dataDir);
  let system = "";
  const ports: EngineHostPorts = {
    ...base,
    memory: memoryOverride ?? base.memory,
    transcriptWriter: { appendCompletedTurn: () => undefined },
    modelTransportDecorator: () => ({
      generate: async (request) => {
        system = request.options.system ?? "";
        const usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        };
        return {
          text: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage,
          totalUsage: usage,
          steps: 1,
        };
      },
    }),
  };
  await new CoachAgent(cyclingSport, ports).chat("chat-1", "hi");
  return system;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the agent injects only the inject-tiered sections into the assembled prompt", () => {
  it("renders inject sections and orphans, drops the non-inject ones", async () => {
    const dataDir = makeDataDir();
    seed(dataDir);
    const system = await capturedSystemPrompt(dataDir);

    expect(system).toContain("Name: Sam; weight 72kg");
    expect(system).toContain("FTP 250W, max HR 188");
    expect(system).toContain("stale orphan body not matching any spec");

    expect(system).not.toContain("prefers hill repeats");
    expect(system).not.toContain("Canyon Ultimate");
    expect(system).not.toContain("left knee tendinopathy");
  });

  it("passes the sport's non-inject section names to both context reads", async () => {
    const dataDir = makeDataDir();
    const contextCalls: Array<readonly string[] | undefined> = [];
    const provenanceCalls: Array<readonly string[] | undefined> = [];
    const memory = Object.assign(new Memory(dataDir), {
      getContext: (opts?: { excludeSections?: readonly string[] }) => {
        contextCalls.push(opts?.excludeSections);
        return "";
      },
      getContextWithProvenance: (opts?: { excludeSections?: readonly string[] }) => {
        provenanceCalls.push(opts?.excludeSections);
        return { text: "", provenance: EMPTY_PROVENANCE };
      },
    }) as unknown as MemoryStorePort;

    await capturedSystemPrompt(dataDir, memory);

    const expected = ["notes", "cycling-equipment", "cycling-history"];
    expect(contextCalls.length).toBeGreaterThan(0);
    expect(provenanceCalls.length).toBeGreaterThan(0);
    for (const call of [...contextCalls, ...provenanceCalls]) {
      expect([...(call ?? [])].sort()).toEqual([...expected].sort());
    }
  });
});
