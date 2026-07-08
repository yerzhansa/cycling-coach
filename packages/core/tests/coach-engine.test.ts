import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { CoachAgent } from "../src/agent/coach-agent.js";
import type { CoachEngineSeam } from "../src/agent/coach-engine.js";

describe("createCoachEngine delegates verbatim to CoachAgent", () => {
  afterEach(() => {
    vi.doUnmock("../src/agent/coach-agent.js");
    vi.resetModules();
  });

  async function setup() {
    const chat = vi.fn(async () => "canned-reply");
    const hasSession = vi.fn(() => true);
    const resetSession = vi.fn(async () => ({ memoryFlushed: false }));
    const memorySentinel = { sentinel: "memory" };
    const ctorArgs: unknown[][] = [];
    vi.doMock("../src/agent/coach-agent.js", () => ({
      CoachAgent: class {
        chat = chat;
        hasSession = hasSession;
        resetSession = resetSession;
        getMemory = () => memorySentinel;
        constructor(...args: unknown[]) {
          ctorArgs.push(args);
        }
      },
    }));
    const { createCoachEngine } = await import("../src/agent/coach-engine.js");
    return { createCoachEngine, chat, hasSession, resetSession, memorySentinel, ctorArgs };
  }

  it("constructs exactly one CoachAgent with verbatim args", async () => {
    const { createCoachEngine, ctorArgs } = await setup();
    const sportSentinel = { sentinel: "sport" } as never;
    const configSentinel = { sentinel: "config" } as never;
    createCoachEngine(sportSentinel, configSentinel);
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0]).toHaveLength(2);
    expect(ctorArgs[0]![0]).toBe(sportSentinel);
    expect(ctorArgs[0]![1]).toBe(configSentinel);
  });

  it("chat forwards all three args and the result", async () => {
    const { createCoachEngine, chat } = await setup();
    const engine = createCoachEngine({} as never, {} as never);
    const turnSentinel = { resolvedCs: null };
    const result = await engine.chat("chat-1", "hello", turnSentinel);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith("chat-1", "hello", turnSentinel);
    expect((chat.mock.calls[0] as unknown[])[2]).toBe(turnSentinel);
    expect(result).toBe("canned-reply");
  });

  it("chat with the third arg omitted forwards undefined", async () => {
    const { createCoachEngine, chat } = await setup();
    const engine = createCoachEngine({} as never, {} as never);
    await engine.chat("chat-1", "hello");
    expect(chat).toHaveBeenCalledTimes(1);
    expect((chat.mock.calls[0] as unknown[])[2]).toBe(undefined);
  });

  it("hasSession forwards and returns", async () => {
    const { createCoachEngine, hasSession } = await setup();
    const engine = createCoachEngine({} as never, {} as never);
    expect(engine.hasSession("chat-2")).toBe(true);
    expect(hasSession).toHaveBeenCalledTimes(1);
    expect(hasSession).toHaveBeenCalledWith("chat-2");
  });

  it("resetSession forwards and returns the delegate's exact object", async () => {
    const { createCoachEngine, resetSession } = await setup();
    const engine = createCoachEngine({} as never, {} as never);
    const result = await engine.resetSession("chat-3");
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession).toHaveBeenCalledWith("chat-3");
    const delegateResult = await resetSession.mock.results[0]!.value;
    expect(result).toBe(delegateResult);
  });

  it("getMemory returns the delegate's Memory instance", async () => {
    const { createCoachEngine, memorySentinel } = await setup();
    const engine = createCoachEngine({} as never, {} as never);
    expect(engine.getMemory()).toBe(memorySentinel);
  });

  it("CoachAgent members exactly equal the seam members (compile-time)", () => {
    expectTypeOf<CoachAgent["chat"]>().toEqualTypeOf<CoachEngineSeam["chat"]>();
    expectTypeOf<CoachAgent["hasSession"]>().toEqualTypeOf<CoachEngineSeam["hasSession"]>();
    expectTypeOf<CoachAgent["resetSession"]>().toEqualTypeOf<CoachEngineSeam["resetSession"]>();
    const toSeam = (a: CoachAgent): CoachEngineSeam => a;
    expect(typeof toSeam).toBe("function");
  });
});
