import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { scriptedPrompts } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

// Ordered prompt contract for a NEW (non-codex) provider with a BASE_URL default:
//   selects: [provider, model, backend]
//   texts:   [base-url]          (custom-model text is skipped by picking a catalog model;
//                                 athlete-id text is skipped by not entering an intervals key)
//   passwords: [llm api_key, intervals (skip), telegram (skip)]

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-providers-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origStdinTTY = process.stdin.isTTY;
  origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.resetModules();
  vi.doMock("../src/secrets/backends/detect.js", () => ({
    detectBackends: vi.fn(async () => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    })),
  }));
});

afterEach(() => {
  process.env.HOME = origHome;
  Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONFIG = () => join(tempHome, ".cycling-coach", "config.yaml");

describe("setup — new providers", () => {
  it("zai fresh install: Enter at base-URL prompt persists the provider default", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["zai", "glm-4.6", "plain"],
        texts: [""], // Enter at the base-URL prompt → falls back to the default
        passwords: ["sk-zai-test", "", ""], // llm key, intervals skip, telegram skip
        confirms: [],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("zai");
    expect(cfg.llm.model).toBe("glm-4.6");
    expect(cfg.llm.base_url).toBe("https://api.z.ai/api/openai/v1");
    expect(cfg.llm.api_key).toBe("sk-zai-test");
  });

  it("minimax fresh install: a typed base URL overrides the default", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["minimax", "MiniMax-M2-Stable", "plain"],
        texts: ["https://proxy.example/v1"],
        passwords: ["sk-minimax-test", "", ""],
        confirms: [],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("minimax");
    expect(cfg.llm.base_url).toBe("https://proxy.example/v1");
  });

  it("openrouter fresh install: writes a namespaced model id + default base URL", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openrouter", "deepseek/deepseek-chat", "plain"],
        texts: [""],
        passwords: ["sk-or-test", "", ""],
        confirms: [],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("openrouter");
    expect(cfg.llm.model).toBe("deepseek/deepseek-chat");
    expect(cfg.llm.base_url).toBe("https://openrouter.ai/api/v1");
  });
});
