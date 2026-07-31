import { afterEach, describe, expect, it } from "vitest";

import {
  classifyUnhandled,
  requestUrlOf,
  routeModelHostAroundMsw,
  startIntervalsMock,
  type IntervalsMockHandle,
} from "./msw.js";
import type { S8aScenario } from "./types.js";

const scenario: S8aScenario = {
  id: "msw-test",
  tier: "replay",
  description: "synthetic",
  intervals: {
    athlete: { id: "i9876543" },
    activities: [{ id: 90101, start_date_local: "1998-07-01T09:00:00", name: "Endurance spin" }],
  },
  turns: [{ chatId: "c1", userMessage: "hi" }],
};

let handle: IntervalsMockHandle | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
});

describe("unhandled-request classification", () => {
  it("bypasses the anthropic lane's model host ONLY in record mode", () => {
    expect(classifyUnhandled("https://api.anthropic.com/v1/messages", "record", "anthropic")).toBe(
      "bypass",
    );
    expect(classifyUnhandled("https://api.anthropic.com/v1/messages", "replay", "anthropic")).toBe(
      "leak",
    );
  });

  it("bypasses the codex lane's model and token hosts ONLY in record mode", () => {
    expect(
      classifyUnhandled("https://chatgpt.com/backend-api/codex/responses", "record", "openai-codex"),
    ).toBe("bypass");
    expect(classifyUnhandled("https://auth.openai.com/oauth/token", "record", "openai-codex")).toBe(
      "bypass",
    );
    expect(
      classifyUnhandled("https://chatgpt.com/backend-api/codex/responses", "replay", "openai-codex"),
    ).toBe("leak");
    expect(classifyUnhandled("https://auth.openai.com/oauth/token", "replay", "openai-codex")).toBe(
      "leak",
    );
  });

  it("never bypasses the other lane's hosts", () => {
    expect(classifyUnhandled("https://chatgpt.com/backend-api", "record", "anthropic")).toBe("leak");
    expect(classifyUnhandled("https://api.anthropic.com/v1/messages", "record", "openai-codex")).toBe(
      "leak",
    );
  });

  it("classifies any other host as a leak in both modes", () => {
    expect(classifyUnhandled("https://example.com/x", "record", "anthropic")).toBe("leak");
    expect(classifyUnhandled("https://example.com/x", "replay", "anthropic")).toBe("leak");
    expect(classifyUnhandled("not a url", "record", "anthropic")).toBe("leak");
    expect(classifyUnhandled("not a url", "record", "openai-codex")).toBe("leak");
  });
});

describe("record-mode model-host routing", () => {
  const responses = (label: string) =>
    ((input: unknown) =>
      Promise.resolve(new Response(`${label}:${requestUrlOf(input)}`))) as typeof globalThis.fetch;

  const routed = (provider: "anthropic" | "openai-codex") =>
    routeModelHostAroundMsw({
      passthrough: responses("passthrough"),
      intercepted: responses("intercepted"),
      provider,
    });

  it("reads the URL off a string, a URL, and a Request", () => {
    expect(requestUrlOf("https://chatgpt.com/x")).toBe("https://chatgpt.com/x");
    expect(requestUrlOf(new URL("https://chatgpt.com/x"))).toBe("https://chatgpt.com/x");
    expect(requestUrlOf(new Request("https://chatgpt.com/x"))).toBe("https://chatgpt.com/x");
    expect(requestUrlOf(undefined)).toBe("");
  });

  it("sends the lane's model and token hosts to the pre-MSW fetch", async () => {
    const fetchLike = routed("openai-codex");
    for (const url of [
      "https://chatgpt.com/backend-api/codex/responses",
      "https://auth.openai.com/oauth/token",
    ]) {
      expect(await (await fetchLike(url)).text()).toBe(`passthrough:${url}`);
    }
  });

  it("leaves every other host — and the other lane's host — on MSW", async () => {
    const fetchLike = routed("openai-codex");
    for (const url of [
      "https://intervals.icu/api/v1/athlete/i9876543",
      "https://api.anthropic.com/v1/messages",
      "https://example.com/x",
    ]) {
      expect(await (await fetchLike(url)).text()).toBe(`intercepted:${url}`);
    }
  });

  it("restores the fetch MSW installed when the mock closes", () => {
    const beforeListen = globalThis.fetch;
    handle = startIntervalsMock(scenario, "record", "openai-codex");
    const duringRecord = globalThis.fetch;
    expect(duringRecord).not.toBe(beforeListen);
    handle.close();
    handle = undefined;
    expect(globalThis.fetch).not.toBe(duringRecord);
    expect(globalThis.fetch).toBe(beforeListen);
  });
});

describe("replay-mode leak detection (exit-2 classification)", () => {
  it("a stray non-intervals fetch sets the leak flag with the first URL", async () => {
    handle = startIntervalsMock(scenario, "replay", "anthropic");
    await expect(fetch("https://example.com/leaky")).rejects.toThrow();
    expect(handle.leak.detected).toBe(true);
    expect(handle.leak.firstUrl).toContain("example.com");
  });

  it("a codex-lane model call during replay sets the leak flag", async () => {
    handle = startIntervalsMock(scenario, "replay", "openai-codex");
    await expect(fetch("https://chatgpt.com/backend-api/codex/responses")).rejects.toThrow();
    expect(handle.leak.detected).toBe(true);
    expect(handle.leak.firstUrl).toContain("chatgpt.com");
  });

  it("intervals mock routes are served without tripping the leak flag", async () => {
    handle = startIntervalsMock(scenario, "replay", "anthropic");
    const response = await fetch("https://intervals.icu/api/v1/athlete/i9876543");
    expect(response.status).toBe(200);
    expect(handle.leak.detected).toBe(false);
  });

  it("the supplementary single-activity route serves the explicit activities section", async () => {
    handle = startIntervalsMock(scenario, "replay", "anthropic");
    const hit = await fetch("https://intervals.icu/api/v1/activity/90101");
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { name: string }).name).toBe("Endurance spin");
    const miss = await fetch("https://intervals.icu/api/v1/activity/90999");
    expect(miss.status).toBe(404);
    expect(handle.leak.detected).toBe(false);
  });
});
