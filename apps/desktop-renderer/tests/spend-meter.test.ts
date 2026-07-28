import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachClient } from "@enduragent/coach-client";
import type { SpendSummary } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import {
  SPEND_REFRESH_INTERVAL_MS,
  createSpendMeterController,
  type SpendMeterView,
} from "../src/spend-meter/controller.js";

function spend(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0.14,
    generationCount: 1,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: "below",
    cacheReadTokens: 400,
    knownCacheReadSavingsUsd: 0.03,
    cacheSavingsComplete: true,
    routes: [
      {
        provider: "anthropic",
        model: "synthetic-model",
        generationCount: 1,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 0,
        providerReportedGenerationCount: 0,
        knownSpendUsd: 0.14,
        cacheReadTokens: 400,
        cacheReadSavingsUsd: 0.03,
        caching: "explicit",
        disclosure: null,
      },
    ],
    ...overrides,
  };
}

function provider(call: CoachClient["call"]): DesktopCoachClientProvider {
  const client = {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  } as CoachClient;
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
}

function fakeView() {
  const summaries: Array<{ readonly summary: SpendSummary; readonly stale: boolean }> = [];
  let saveHandler: (() => void) | undefined;
  let cap = 0.75;
  const view: SpendMeterView = {
    renderLoading: vi.fn(),
    renderSummary: vi.fn((summary, options) => summaries.push({ summary, stale: options.stale })),
    renderUnavailable: vi.fn(),
    bindSave: vi.fn((handler) => {
      saveHandler = handler;
    }),
    readDailyCapUsd: vi.fn(() => cap),
    setSaving: vi.fn(),
    showCapInputError: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    summaries,
    save: () => saveHandler?.(),
    setCap: (value: number) => {
      cap = value;
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("spend controller", () => {
  it("starts once, refreshes immediately and every thirty seconds, and shares an active refresh", async () => {
    const gate = deferred<SpendSummary>();
    const call = vi.fn(async () => gate.promise) as unknown as CoachClient["call"];
    const subject = fakeView();
    let intervalCallback: (() => void) | undefined;
    const controller = createSpendMeterController({
      clients: provider(call),
      view: subject.view,
      setInterval: ((callback: () => void, delay: number) => {
        expect(delay).toBe(SPEND_REFRESH_INTERVAL_MS);
        intervalCallback = callback;
        return 1;
      }) as never,
      clearInterval: vi.fn() as never,
    });
    controller.start();
    controller.start();
    const first = controller.refresh();
    const second = controller.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    gate.resolve(spend());
    await first;
    intervalCallback?.();
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(2);
    expect(subject.view.bindSave).toHaveBeenCalledTimes(1);
    expect(subject.view.renderLoading).toHaveBeenCalledTimes(1);
  });

  it("preserves last-good data as stale and ignores settlement after disposal", async () => {
    let calls = 0;
    const late = deferred<SpendSummary>();
    const call = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return spend();
      if (calls === 2) throw new Error("unavailable");
      return late.promise;
    }) as unknown as CoachClient["call"];
    const subject = fakeView();
    const clearInterval = vi.fn();
    const controller = createSpendMeterController({
      clients: provider(call),
      view: subject.view,
      setInterval: (() => 2) as never,
      clearInterval: clearInterval as never,
    });
    controller.start();
    await controller.refresh();
    await controller.refresh();
    expect(subject.view.renderUnavailable).toHaveBeenLastCalledWith({ hadSummary: true });
    const pending = controller.refresh();
    controller.dispose();
    late.resolve(spend({ knownSpendUsd: 0.2 }));
    await pending;
    expect(subject.summaries.at(-1)?.summary.knownSpendUsd).toBe(0.14);
    expect(clearInterval).toHaveBeenCalledWith(2);
    expect(subject.view.dispose).toHaveBeenCalledTimes(1);
  });

  it("validates caps locally and coalesces refreshes requested during one save", async () => {
    const saved = spend({ dailyCapUsd: 0.75 });
    const calls: string[] = [];
    const call = vi.fn(async (method: string) => {
      calls.push(method);
      return method === "setDailySpendCap" ? saved : spend({ dailyCapUsd: 0.75 });
    }) as unknown as CoachClient["call"];
    const subject = fakeView();
    const controller = createSpendMeterController({
      clients: provider(call),
      view: subject.view,
      setInterval: (() => 1) as never,
      clearInterval: vi.fn() as never,
    });
    controller.start();
    await controller.refresh();
    const save = controller.saveDailyCap();
    const postOne = controller.refresh();
    const postTwo = controller.refresh();
    expect(postOne).toBe(postTwo);
    await Promise.all([save, postOne]);
    expect(calls.filter((method) => method === "setDailySpendCap")).toHaveLength(1);
    expect(calls.slice(-2)).toEqual(["setDailySpendCap", "getSpendSummary"]);
    subject.setCap(0);
    await controller.saveDailyCap();
    expect(subject.view.showCapInputError).toHaveBeenLastCalledWith(
      "Enter a daily cap greater than $0.",
    );
  });
});
