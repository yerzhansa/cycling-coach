import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachClient } from "@enduragent/coach-client";
import type { SpendSummary } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import {
  SPEND_REFRESH_INTERVAL_MS,
  createSpendMeterController,
  type SpendMeterView,
} from "../src/spend-meter/controller.js";
import { createSpendMeterView } from "../src/spend-meter/view.js";

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

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Set<() => void>>();
  readonly classList = {
    add: (value: string) => {
      const values = new Set(this.className.split(/\s+/u).filter(Boolean));
      values.add(value);
      this.className = [...values].join(" ");
    },
  };
  parent: FakeElement | undefined;
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  id = "";
  type = "";
  step = "";
  inputMode = "";
  htmlFor = "";
  title = "";
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  append(...nodes: FakeElement[]): void {
    for (const child of nodes) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.ownText = "";
    this.children.splice(0);
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[name.slice(5)];
  }

  addEventListener(name: string, listener: () => void): void {
    const values = this.listeners.get(name) ?? new Set();
    values.add(listener);
    this.listeners.set(name, values);
  }

  removeEventListener(name: string, listener: () => void): void {
    this.listeners.get(name)?.delete(listener);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }
}

class FakeDocument {
  createElement(name: string): FakeElement {
    return new FakeElement(name);
  }
}

function find(root: FakeElement, predicate: (value: FakeElement) => boolean): FakeElement {
  if (predicate(root)) return root;
  for (const child of root.children) {
    try {
      return find(child, predicate);
    } catch {}
  }
  throw new Error("not found");
}

beforeEach(() => {
  Object.assign(globalThis, { document: new FakeDocument(), HTMLElement: FakeElement });
});

describe("spend view", () => {
  it("renders semantic reached, incomplete, route disclosure, ARIA, and exact warning copy", () => {
    const root = new FakeElement("div");
    root.className = "spend-meter";
    root.setAttribute("aria-label", "Today’s spend is not available yet");
    const noticeHost = new FakeElement("div");
    const view = createSpendMeterView({ root: root as never, noticeHost: noticeHost as never });
    view.renderSummary(
      spend({
        dailyCapUsd: 0.1,
        knownSpendUsd: 0.14,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 1,
        generationCount: 2,
        malformedLineCount: 1,
        spendComplete: false,
        capStatus: "reached",
        cacheSavingsComplete: false,
        routes: [
          {
            provider: "openrouter",
            model: "anthropic/synthetic",
            generationCount: 2,
            pricedGenerationCount: 1,
            unpricedGenerationCount: 1,
            providerReportedGenerationCount: 1,
            knownSpendUsd: 0.14,
            cacheReadTokens: 400,
            cacheReadSavingsUsd: null,
            caching: "unavailable",
            disclosure: "caching unavailable on this route",
          },
        ],
      }),
      { stale: true },
    );
    expect(root.dataset.capStatus).toBe("reached");
    expect(root.textContent).toContain("$0.14+ / $0.10");
    expect(root.textContent).toContain(
      "Some provider costs are unavailable, so today’s total is a known minimum.",
    );
    expect(root.textContent).toContain("Some usage records could not be read.");
    expect(root.textContent).toContain("Spend data may be out of date.");
    expect(root.textContent).toContain("caching unavailable on this route");
    const progress = find(root, (element) => element.attributes.get("role") === "progressbar");
    expect(progress.attributes.get("aria-valuemax")).toBe("0.1");
    expect(progress.attributes.get("aria-valuenow")).toBe("0.1");
    expect(progress.attributes.get("aria-valuetext")).toBe("$0.14+ of $0.10");
    const warning = find(noticeHost, (element) => element.id === "spend-cap-warning");
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe(
      "You’ve reached today’s $0.10 spend cap. You can keep chatting; this is a warning, not a block.",
    );
  });

  it("renders unavailable state, validates the visible cap editor, and removes only its warning", () => {
    const root = new FakeElement("div");
    const noticeHost = new FakeElement("div");
    const preserved = new FakeElement("p");
    preserved.textContent = "preserved";
    noticeHost.append(preserved);
    const view = createSpendMeterView({ root: root as never, noticeHost: noticeHost as never });
    view.renderUnavailable({ hadSummary: false });
    expect(root.textContent).toContain("Spend data unavailable.");
    expect(root.textContent).toContain("Daily cap (USD)");
    const input = find(root, (element) => element.id === "daily-spend-cap");
    input.value = "0.25";
    expect(view.readDailyCapUsd()).toBe(0.25);
    view.dispose();
    expect(noticeHost.textContent).toBe("preserved");
  });

  it("preserves a dirty cap edit across refresh and reconciles the committed value", () => {
    const root = new FakeElement("div");
    const view = createSpendMeterView({
      root: root as never,
      noticeHost: new FakeElement("div") as never,
    });
    view.renderSummary(spend(), { stale: false });
    const input = find(root, (element) => element.id === "daily-spend-cap");
    input.value = "0.75";
    input.dispatch("input");
    view.renderSummary(spend({ knownSpendUsd: 0.2 }), { stale: false });
    expect(input.value).toBe("0.75");
    view.renderSummary(spend({ dailyCapUsd: 0.75 }), { stale: false });
    expect(input.value).toBe("0.75");
    view.renderSummary(spend({ dailyCapUsd: 0.5 }), { stale: false });
    expect(input.value).toBe("0.5");
  });
});
