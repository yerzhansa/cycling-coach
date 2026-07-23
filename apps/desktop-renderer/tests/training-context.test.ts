import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { AthleteState, CyclingTrainingContext } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import {
  createTrainingContextController,
  type TrainingContextViewState,
} from "../src/training-context/controller.js";
import {
  formatDateLabel,
  formatPercentage,
  formatSleepDuration,
  formatUtcTimestamp,
  formatWholeNumber,
} from "../src/training-context/format.js";
import { mountTrainingContextView } from "../src/training-context/view.js";

const context: CyclingTrainingContext = {
  anchorZones: { kind: "unknown", reason: "missing-anchor" },
  cyclingLoad: {
    kind: "computed",
    asOf: "2026-07-18T00:00:00.000Z",
    source: "intervals.icu",
    windowDays: 7,
    value: 120,
    activityCount: 2,
    missingLoadCount: 1,
  },
  plan: { kind: "unknown", reason: "no-plan" },
  adherence: { kind: "unknown", reason: "insufficient-data" },
  wellnessTrend: { kind: "unknown", reason: "no-wellness" },
};

function athlete(trainingContext: CyclingTrainingContext | undefined = context): AthleteState {
  return {
    schemaVersion: "3",
    lastUpdated: "2026-07-18T00:00:00.000Z",
    freshness: "flag",
    degraded: true,
    lastSynced: "2026-07-17T23:00:00.000Z",
    athleteProfile: { hidden: true },
    currentStatus: { hidden: true },
    derivedMetrics: { hidden: true },
    recentActivities: [{ hidden: true }],
    plannedWorkouts: [{ hidden: true }],
    wellness: { hidden: true },
    ...(trainingContext === undefined ? {} : { trainingContext }),
  };
}

function providerWith(call: CoachClient["call"]): DesktopCoachClientProvider {
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

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  className = "";
  open = false;
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  get dateTime(): string {
    return this.getAttribute("datetime") ?? "";
  }

  set dateTime(value: string) {
    this.setAttribute("datetime", value);
  }

  append(...values: Array<FakeElement | string>): void {
    for (const value of values) {
      const child = typeof value === "string" ? new FakeElement("#TEXT") : value;
      if (typeof value === "string") child.textContent = value;
      this.children.push(child);
    }
  }

  replaceChildren(...values: Array<FakeElement | string>): void {
    this.ownText = "";
    this.children.splice(0);
    this.append(...values);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(_name: string, _listener: (event: Event) => void): void {}

  removeEventListener(_name: string, _listener: (event: Event) => void): void {}

  focus(): void {}

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

class FakeDocument {
  createElement(name: string): FakeElement {
    return new FakeElement(name.toUpperCase());
  }

  createTextNode(value: string): FakeElement {
    const node = new FakeElement("#TEXT");
    node.textContent = value;
    return node;
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function elementsByTagName(root: FakeElement, tagName: string): FakeElement[] {
  const normalized = tagName.toUpperCase();
  return descendants(root).filter((element) => element.tagName === normalized);
}

function readyViewState(lastSynced: string): TrainingContextViewState {
  return {
    status: "ready",
    metadata: {
      lastUpdated: "1998-07-18T23:58:01.000Z",
      lastSynced,
      freshness: "fresh",
      degraded: false,
    },
    trainingContext: {
      anchorZones: {
        kind: "computed",
        asOf: "1998-07-19T21:22:23.000Z",
        anchor: {
          watts: 250,
          validFrom: "1998-06-01",
          source: "manual",
          confidence: "manual",
          ageDays: 48,
          stalenessBand: "aging",
          stale: true,
        },
        zones: Array.from({ length: 6 }, (_, index) => ({
          name: `Zone ${index + 1}`,
          range: `${index + 1} W`,
          overlaps: false,
        })),
      },
      cyclingLoad: context.cyclingLoad,
      plan: {
        kind: "computed",
        asOf: "1998-07-20T10:11:12.000Z",
        items: [
          {
            id: "synthetic-plan-item",
            date: "1998-07-20T10:11:12.000Z",
            name: "Endurance ride",
            category: "WORKOUT",
            workoutType: "Ride",
          },
        ],
      },
      adherence: {
        kind: "computed",
        asOf: "1998-07-21T13:14:15.000Z",
        ratio: 0.5,
        plannedDays: 2,
        completedDays: 3,
        matchedDays: 1,
      },
      wellnessTrend: {
        kind: "computed",
        asOf: "1998-07-22T16:17:18.000Z",
        windowDays: 7,
        series: [
          { metric: "hrv", unit: "ms", points: [] },
          { metric: "sleep", unit: "seconds", points: [] },
          { metric: "resting-hr", unit: "bpm", points: [] },
        ],
      },
    },
    unitsPreference: { status: "ready", value: "metric", source: "default" },
  };
}

describe("training context controller", () => {
  it("fetches canonical state and units once on start without exposing raw state fields", async () => {
    const calls: string[] = [];
    const clients = providerWith((async (method: string) => {
      calls.push(method);
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") return { value: "imperial", source: "athlete" };
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await Promise.all([controller.start(), controller.start()]);
    expect(calls.sort()).toEqual(["getAthleteState", "getUnitsPreference"]);
    expect(states.at(-1)).toEqual({
      status: "ready",
      metadata: {
        lastUpdated: "2026-07-18T00:00:00.000Z",
        lastSynced: "2026-07-17T23:00:00.000Z",
        freshness: "flag",
        degraded: true,
      },
      trainingContext: context,
      unitsPreference: { status: "ready", value: "imperial", source: "athlete" },
    });
    expect(JSON.stringify(states.at(-1))).not.toContain("hidden");
  });

  it("uses the explicit fallback for an older state and retains it on refresh failure", async () => {
    let stateCalls = 0;
    const clients = providerWith((async (method: string) => {
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "getAthleteState") {
        stateCalls += 1;
        if (stateCalls === 1) {
          const older = athlete();
          delete older.trainingContext;
          return older;
        }
        throw new Error("unavailable");
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    const previous = states.at(-1)?.trainingContext;
    await controller.refresh();
    expect(states.at(-1)?.status).toBe("refresh-unavailable");
    expect(states.at(-1)?.trainingContext).toEqual(previous);
    expect(states.at(-1)?.trainingContext.anchorZones).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
  });

  it("coalesces refreshes during an active read into one post-flight request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stateCalls = 0;
    const clients = providerWith((async (method: string) => {
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "getAthleteState") {
        stateCalls += 1;
        if (stateCalls === 2) await gate;
        return { ...athlete(), lastUpdated: `1998-07-0${stateCalls}T00:00:00.000Z` };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    const first = controller.refresh();
    const second = controller.refresh();
    release();
    await Promise.all([first, second]);
    expect(stateCalls).toBe(3);
    expect(states.at(-1)?.metadata?.lastUpdated).toBe("1998-07-03T00:00:00.000Z");
  });

  it("reconnects the next athlete-state read after a disconnect", async () => {
    let stateCalls = 0;
    const clients = providerWith((async (method: string) => {
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "getAthleteState") {
        stateCalls += 1;
        if (stateCalls === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
        return athlete();
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    await controller.refresh();
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("uses a shared recovered client instead of reconnecting a stale failed instance", async () => {
    const failed = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method: string) => {
        if (method === "getAthleteState") {
          throw new CoachClientDisconnectedError(1006, "synthetic");
        }
        return { value: "metric", source: "default" };
      }) as CoachClient["call"],
      close: vi.fn(async () => {}),
    } as CoachClient;
    const recovered = {
      handshake: {} as CoachClient["handshake"],
      call: vi.fn(async (method: string) => {
        if (method === "getAthleteState") return athlete();
        return { value: "metric", source: "default" };
      }) as CoachClient["call"],
      close: vi.fn(async () => {}),
    } as CoachClient;
    let current = failed;
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => current),
      reconnect: vi.fn(async () => recovered),
      close: vi.fn(async () => {}),
    };
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    current = recovered;
    await controller.refresh();
    expect(clients.reconnect).not.toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("renders only the authoritative units result and retains selection on failed save", async () => {
    let fail = false;
    const calls: Array<{ method: string; request: unknown }> = [];
    const clients = providerWith((async (method: string, request: unknown) => {
      calls.push({ method, request });
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") return { value: "metric", source: "default" };
      if (method === "setUnitsPreference") {
        if (fail) throw new Error("save failed");
        return { value: "imperial", source: "cycling" };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const states: TrainingContextViewState[] = [];
    const controller = createTrainingContextController({
      clients,
      view: { render: (state) => states.push(structuredClone(state)) },
    });
    await controller.start();
    await controller.setUnitsPreference("imperial");
    expect(states.at(-1)?.unitsPreference).toEqual({
      status: "ready",
      value: "imperial",
      source: "cycling",
    });
    fail = true;
    await controller.setUnitsPreference("metric");
    expect(states.at(-1)?.unitsPreference).toEqual({
      status: "unavailable",
      value: "imperial",
      source: "cycling",
    });
    expect(calls.filter((entry) => entry.method === "setUnitsPreference")).toEqual([
      { method: "setUnitsPreference", request: { value: "imperial" } },
      { method: "setUnitsPreference", request: { value: "metric" } },
    ]);
  });

  it("reconciles a disconnected save before applying the next explicit selection", async () => {
    let stored: "metric" | "imperial" = "metric";
    let disconnected = true;
    const calls: string[] = [];
    const clients = providerWith((async (method: string, request: unknown) => {
      calls.push(method);
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") {
        return { value: stored, source: stored === "metric" ? "default" : "cycling" };
      }
      if (method === "setUnitsPreference") {
        if (disconnected) {
          disconnected = false;
          throw new CoachClientDisconnectedError(1006, "synthetic");
        }
        stored = (request as { value: "metric" | "imperial" }).value;
        return { value: stored, source: "cycling" };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const controller = createTrainingContextController({ clients, view: { render() {} } });
    await controller.start();
    await controller.setUnitsPreference("imperial");
    await controller.setUnitsPreference("imperial");
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(calls.slice(-3)).toEqual([
      "setUnitsPreference",
      "getUnitsPreference",
      "setUnitsPreference",
    ]);
    expect(stored).toBe("imperial");
  });

  it("reconnects and reconciles when the initial units read disconnects", async () => {
    let unitReads = 0;
    let stored: "metric" | "imperial" = "metric";
    const clients = providerWith((async (method: string, request: unknown) => {
      if (method === "getAthleteState") return athlete();
      if (method === "getUnitsPreference") {
        unitReads += 1;
        if (unitReads === 1) throw new CoachClientDisconnectedError(1006, "synthetic");
        return { value: stored, source: "default" };
      }
      if (method === "setUnitsPreference") {
        stored = (request as { value: "metric" | "imperial" }).value;
        return { value: stored, source: "cycling" };
      }
      throw new TypeError();
    }) as CoachClient["call"]);
    const controller = createTrainingContextController({ clients, view: { render() {} } });
    await controller.start();
    await controller.setUnitsPreference("imperial");
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(stored).toBe("imperial");
  });

  it("ignores late responses after disposal", async () => {
    let resolve!: (value: AthleteState) => void;
    const pending = new Promise<AthleteState>((accept) => {
      resolve = accept;
    });
    const clients = providerWith((async (method: string) => {
      if (method === "getAthleteState") return pending;
      return { value: "metric", source: "default" };
    }) as CoachClient["call"]);
    const render = vi.fn();
    const controller = createTrainingContextController({ clients, view: { render } });
    const started = controller.start();
    controller.dispose();
    resolve(athlete());
    await started;
    expect(render).toHaveBeenCalledTimes(3);
  });
});

describe("training context display formatters", () => {
  it("formats only display values without clock or locale inputs", () => {
    expect(formatDateLabel("2026-07-18T12:00:00Z")).toBe("2026-07-18");
    expect(formatDateLabel("2026-02-30")).toBe("Unknown date");
    expect(formatWholeNumber(12.6)).toBe("13");
    expect(formatPercentage(0.756)).toBe("76%");
    expect(formatSleepDuration(27_901)).toBe("7h 45m");
  });

  it("distinguishes same-day sync seconds while mutation labels remain date-only", () => {
    expect(formatUtcTimestamp("1998-07-18T12:34:56.999Z")).toBe("1998-07-18 12:34:56 UTC");
    expect(formatUtcTimestamp("1998-07-18T12:34:57.001Z")).toBe("1998-07-18 12:34:57 UTC");
    expect(formatDateLabel("1998-07-18T12:34:57.001Z")).toBe("1998-07-18");
  });

  it("normalizes valid offsets to UTC and uses fixed copy for invalid sync times", () => {
    expect(formatUtcTimestamp("1998-07-18T18:34:56+06:00")).toBe("1998-07-18 12:34:56 UTC");
    expect(formatUtcTimestamp("not-an-instant")).toBe("Unknown sync time");
    expect(formatUtcTimestamp("1998-02-30T12:34:56Z")).toBe("Unknown sync time");
  });
});

describe("training context drawer contract", () => {
  it("pins panel order, approved units copy, unknown states, and accessible drawer behavior", async () => {
    const source = await readFile(
      new URL("../src/training-context/view.ts", import.meta.url),
      "utf8",
    );
    const order = [
      "Current cycling anchor",
      "Cycling Load",
      "Plan",
      "Adherence",
      "Wellness trend",
    ].map((value) => source.indexOf(`"${value}"`));
    expect(order.every((value) => value >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    for (const copy of [
      "Metric · km · kg · W/kg",
      "Imperial · mi · lb · W/kg",
      "Distance and body mass follow this setting. Cycling power-to-weight remains W/kg.",
      "Not synced yet",
      "No cycling FTP anchor is available",
      "No platform Load is available for the last 7 days",
      "No planned cycling workouts are available",
      "Not enough persisted data to show this yet",
      "No wellness readings are available",
      "Training data drawer",
      "Open training data",
      "Close training data",
    ]) {
      expect(source).toContain(copy);
    }
    expect(source).toContain("showModal()");
    expect(source).toContain('addEventListener("cancel", cancel)');
    expect(source).toContain('setAttribute("aria-expanded", "true")');
    expect(source).toContain("close.focus()");
    expect(source).toContain("opener.focus()");
  });

  it("renders sync timestamps semantically while keeping date surfaces date-only", () => {
    const document = new FakeDocument();
    vi.stubGlobal("document", document);

    try {
      const spine = document.createElement("aside");
      const drawer = document.createElement("dialog");
      const mounted = mountTrainingContextView({
        spine: spine as unknown as HTMLElement,
        drawer: drawer as unknown as HTMLDialogElement,
      });

      mounted.view.render(readyViewState("1998-07-18T18:34:56+06:00"));

      const validText = drawer.textContent;
      const validSyncItem = elementsByTagName(drawer, "p").find((element) =>
        element.textContent.startsWith("Last synced"),
      );
      expect(validSyncItem?.textContent).toBe("Last synced 1998-07-18 12:34:56 UTC");
      const timeElements = elementsByTagName(drawer, "time");
      expect(timeElements).toHaveLength(1);
      expect(validSyncItem?.children).toContain(timeElements[0]);
      expect(timeElements[0]?.getAttribute("datetime")).toBe("1998-07-18T12:34:56.000Z");
      expect(timeElements[0]?.textContent).toBe("1998-07-18 12:34:56 UTC");
      for (const dateOnlyText of [
        "As of 1998-07-18",
        "As of 1998-07-19 · manual · manual",
        "1998-07-20 · Ride",
        "3 completed days · As of 1998-07-21",
        "As of 1998-07-22 · 7 mornings",
      ]) {
        expect(validText).toContain(dateOnlyText);
      }
      for (const hiddenClock of ["23:58:01", "21:22:23", "10:11:12", "13:14:15", "16:17:18"]) {
        expect(validText).not.toContain(hiddenClock);
      }

      const invalidTimestamp = "private-invalid-sync-value";
      mounted.view.render(readyViewState(invalidTimestamp));

      const invalidSyncItem = elementsByTagName(drawer, "p").find((element) =>
        element.textContent.startsWith("Last synced"),
      );
      expect(invalidSyncItem?.textContent).toBe("Last synced Unknown sync time");
      expect(elementsByTagName(drawer, "time")).toHaveLength(0);
      expect(drawer.textContent).not.toContain(invalidTimestamp);
      mounted.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the panel surface free of excluded balance labels and local metric claims", async () => {
    const source = await readFile(
      new URL("../src/training-context/view.ts", import.meta.url),
      "utf8",
    );
    expect(source.toLowerCase()).not.toContain("locally-computed");
    expect(source.toLowerCase()).not.toContain("locally computed");
    expect(source.toLowerCase()).not.toContain("fitness");
    expect(source.toLowerCase()).not.toContain("fatigue");
  });
});
