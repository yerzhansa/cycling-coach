import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "t".repeat(43);
const fixtures: RunningDesktopFixture[] = [];
const scratchPaths: string[] = [];

const trainingContext = {
  anchorZones: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    anchor: {
      watts: 300,
      validFrom: "2026-07-01",
      source: "intervals.icu",
      confidence: "platform",
      ageDays: 18,
      stalenessBand: "fresh",
      stale: false,
    },
    zones: [
      { name: "Recovery", range: "0–164 W", overlaps: false },
      { name: "Endurance", range: "165–224 W", overlaps: false },
      { name: "Tempo", range: "225–269 W", overlaps: false },
      { name: "Threshold", range: "270–314 W", overlaps: false },
      { name: "VO₂ max", range: "315–359 W", overlaps: false },
      { name: "Anaerobic", range: "360+ W", overlaps: false },
    ],
  },
  cyclingLoad: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    source: "intervals.icu",
    windowDays: 7,
    value: 240,
    activityCount: 3,
    missingLoadCount: 1,
  },
  plan: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    items: [
      {
        id: "plan-1",
        date: "2026-07-20",
        name: "Tempo ride",
        category: "WORKOUT",
        workoutType: "Ride",
      },
    ],
  },
  adherence: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    ratio: 0.8,
    plannedDays: 5,
    completedDays: 4,
    matchedDays: 4,
  },
  wellnessTrend: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    windowDays: 7,
    series: [
      { metric: "hrv", unit: "ms", points: [{ date: "2026-07-19", value: 65 }] },
      { metric: "sleep", unit: "seconds", points: [{ date: "2026-07-19", value: 27_000 }] },
      { metric: "resting-hr", unit: "bpm", points: [{ date: "2026-07-19", value: 48 }] },
    ],
  },
} as const;

const athleteState = {
  schemaVersion: "1",
  lastUpdated: "2026-07-19T08:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-19T07:55:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
  trainingContext,
} as const;

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function makeScript(calls: ScriptRequest[]): DesktopFixtureScript {
  let units: "metric" | "imperial" = "metric";
  let hasSession = false;
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      calls.push(request);
      if (request.method === "getAthleteState") return response(athleteState);
      if (request.method === "getUnitsPreference") {
        return response({ value: units, source: units === "metric" ? "default" : "cycling" });
      }
      if (request.method === "setUnitsPreference") {
        units = (request.params as { readonly value: "metric" | "imperial" }).value;
        return response({ value: units, source: "cycling" });
      }
      if (request.method === "chat") {
        hasSession = true;
        return [
          JSON.stringify({ type: "text_delta", turnId: "turn-fixture", delta: "Hold " }),
          JSON.stringify({ type: "text_delta", turnId: "turn-fixture", delta: "steady" }),
          JSON.stringify({ type: "final-text", turnId: "turn-fixture", text: "Hold steady." }),
          JSON.stringify({ text: "Hold steady." }),
        ];
      }
      if (request.method === "hasSession") return response({ hasSession });
      if (request.method === "resetSession") {
        hasSession = false;
        return response({ memoryFlushed: true });
      }
      if (request.method === "sync") {
        return response({
          schemaVersion: 1,
          published: false,
          referenceSucceeded: true,
          requests: { store: 0, reference: 0, total: 0 },
        });
      }
      if (request.method === "importFiles") {
        return response({
          schemaVersion: 1,
          files: { total: 1, imported: 1, quarantined: 0 },
          changes: {
            rawFilesInserted: 1,
            sourceRecordsInserted: 1,
            sourceRecordsUpdated: 0,
            relinkedSourceRecords: 0,
          },
        });
      }
      if (request.method === "saveIntake") return response({ schemaVersion: 1, saved: true });
      if (request.method === "configureRuntime") {
        return response({ schemaVersion: 1, applied: { llm: true, intervals: true } });
      }
      throw new TypeError(`unexpected fixture method ${request.method}`);
    },
  };
}

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

async function launch(input: {
  readonly width: number;
  readonly height: number;
  readonly reducedMotion: boolean;
}): Promise<{ readonly fixture: RunningDesktopFixture; readonly calls: ScriptRequest[] }> {
  const calls: ScriptRequest[] = [];
  const fixture = await launchDesktopFixture({
    script: makeScript(calls),
    token,
    width: input.width,
    height: input.height,
    colorScheme: "light",
    reducedMotion: input.reducedMotion,
  });
  fixtures.push(fixture);
  await fixture.evaluate<void>(`
    const deadline = Date.now() + 10000;
    while ((document.documentElement.dataset.rpc !== "connected" || document.querySelector(".drawer-status")?.textContent !== "") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    document.querySelector(".onboarding")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  `);
  return { fixture, calls };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(
    scratchPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("desktop chat panels", () => {
  it("streams chat, persists units, preserves focus, and fits desktop geometry", async () => {
    const { fixture, calls } = await launch({ width: 1440, height: 900, reducedMotion: false });
    const initial = await fixture.evaluate<{
      readonly location: string;
      readonly bridgeKeys: readonly string[];
      readonly thread: boolean;
      readonly partial: string;
      readonly final: string;
      readonly drawerStatus: string;
      readonly anchorValue: string;
      readonly wellnessValue: string;
    }>(`
      const bridgeKeys = Object.keys(window.enduragentAuth).sort();
      const thread = document.querySelectorAll(".thread").length === 1;
      const textarea = document.querySelector("#message");
      const observed = [];
      const observer = new MutationObserver(() => {
        const value = document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
        if (value.length > 0) observed.push(value);
      });
      observer.observe(document.querySelector(".chat-messages"), {
        childList: true,
        characterData: true,
        subtree: true,
      });
      textarea.value = "What should I ride?";
      textarea.closest("form").requestSubmit();
      const finalDeadline = Date.now() + 5000;
      let final = "";
      while (final !== "Hold steady." && Date.now() < finalDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        final = document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
      }
      observer.disconnect();
      const partial = observed.find((value) => value === "Hold " || value === "Hold steady") ?? "";
      const panels = [...document.querySelectorAll(".context-panel__body")];
      return {
        location: location.href,
        bridgeKeys,
        thread,
        partial,
        final,
        drawerStatus: document.querySelector(".drawer-status")?.textContent ?? "missing",
        anchorValue: panels[0]?.querySelector(".context-panel__value")?.textContent ?? "",
        wellnessValue: panels[4]?.querySelector(".wellness-row__value")?.textContent ?? "",
      };
    `);
    expect(initial).toEqual({
      location: "enduragent://app/index.html",
      bridgeKeys: [
        "chatgptLogin",
        "chatgptStatus",
        "chooseImportFiles",
        "credentialStatuses",
        "getDaemonConnection",
        "onDroppedImportFiles",
        "retryFailedCredentials",
        "writeCredential",
      ],
      thread: true,
      partial: expect.stringMatching(/^Hold (steady)?$/u),
      final: "Hold steady.",
      drawerStatus: "",
      anchorValue: "300 W",
      wellnessValue: "65 ms",
    });
    expect(calls.filter((call) => call.method === "hasSession")).toEqual([
      {
        jsonrpc: "2.0",
        method: "hasSession",
        params: { chatId: "desktop" },
      },
    ]);
    const reset = await fixture.evaluate<{
      readonly enabledBefore: boolean;
      readonly dialogOpen: boolean;
      readonly transcriptEmpty: boolean;
      readonly composerValue: string;
      readonly composerDisabled: boolean;
      readonly resetDisabled: boolean;
      readonly focused: string | null;
    }>(`
      const opener = document.querySelector(".new-conversation-button");
      const textarea = document.querySelector("#message");
      const readyDeadline = Date.now() + 5000;
      while ((opener.disabled || opener.getAttribute("aria-disabled") === "true" || textarea.disabled) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const enabledBefore = !opener.disabled && opener.getAttribute("aria-disabled") !== "true" && !textarea.disabled;
      if (enabledBefore) opener.click();
      const dialog = document.querySelector(".new-conversation-dialog");
      const dialogOpen = dialog.open;
      if (dialogOpen) dialog.querySelector(".new-conversation-dialog__confirm").click();
      const resetDeadline = Date.now() + 5000;
      while (dialog.open && Date.now() < resetDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return {
        enabledBefore,
        dialogOpen,
        transcriptEmpty: document.querySelectorAll(".chat-message").length === 0,
        composerValue: textarea.value,
        composerDisabled: textarea.disabled,
        resetDisabled: opener.disabled,
        focused: document.activeElement?.id ?? null,
      };
    `);
    expect(reset).toEqual({
      enabledBefore: true,
      dialogOpen: true,
      transcriptEmpty: true,
      composerValue: "",
      composerDisabled: false,
      resetDisabled: true,
      focused: "message",
    });
    expect(calls.filter((call) => call.method === "resetSession")).toEqual([
      {
        jsonrpc: "2.0",
        method: "resetSession",
        params: { chatId: "desktop" },
      },
    ]);
    const drawer = await fixture.evaluate<{
      readonly open: boolean;
      readonly focused: string | null;
      readonly label: string | null;
      readonly order: readonly string[];
      readonly spineWidth: number;
      readonly closedFocus: string | null;
      readonly overflow: boolean;
      readonly units: string;
    }>(`
      const opener = document.querySelector(".drawer-toggle");
      opener.click();
      const drawer = document.querySelector("#training-context-drawer");
      const opened = {
        open: drawer.open,
        focused: document.activeElement?.getAttribute("aria-label") ?? null,
        label: drawer.getAttribute("aria-label"),
        order: [...drawer.querySelectorAll(".context-panel > h3")].map((node) => node.textContent),
        spineWidth: document.querySelector(".data-spine").getBoundingClientRect().width,
      };
      const imperial = drawer.querySelector('input[value="imperial"]');
      imperial.click();
      const unitsDeadline = Date.now() + 5000;
      while ((!imperial.checked || imperial.disabled) && Date.now() < unitsDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      drawer.querySelector(".drawer-close").click();
      return {
        ...opened,
        closedFocus: document.activeElement?.getAttribute("aria-label") ?? null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        units: imperial.checked ? imperial.value : "",
      };
    `);
    expect(drawer).toEqual({
      open: true,
      focused: "Close training data",
      label: "Training data",
      order: ["Current cycling anchor", "Cycling Load", "Plan", "Adherence", "Wellness trend"],
      spineWidth: 48,
      closedFocus: "Open training data",
      overflow: false,
      units: "imperial",
    });
    expect(calls.filter((call) => call.method === "chat")).toEqual([
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "What should I ride?" },
      },
    ]);
    expect(calls.filter((call) => call.method === "setUnitsPreference")).toEqual([
      { jsonrpc: "2.0", method: "setUnitsPreference", params: { value: "imperial" } },
    ]);
    await fixture.setViewport(720, 800);
    expect(
      await fixture.evaluate<{ readonly documentOverflow: boolean; readonly topbarFits: boolean }>(`
      const topbar = document.querySelector(".topbar");
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        topbarFits: topbar.scrollWidth <= topbar.clientWidth,
      };
    `),
    ).toEqual({ documentOverflow: false, topbarFits: true });
    const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
    const screenshotRoot = await mkdtemp(join(base, "eap-shot-"));
    scratchPaths.push(screenshotRoot);
    const screenshotPath = join(screenshotRoot, "chat-panels.png");
    await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });
    await fixture.screenshot(screenshotPath);
    const screenshot = await readFile(screenshotPath);
    expect(screenshot.includes(Buffer.from(token))).toBe(false);
    for (const name of ["location", "console", "stdout", "stderr", "dom"] as const) {
      expect(fixture.readCapturedSurface(name)).not.toContain(token);
    }
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 30_000);

  it("honors reduced motion at the compact viewport", async () => {
    const { fixture } = await launch({ width: 720, height: 800, reducedMotion: true });
    expect(
      await fixture.evaluate<{
        readonly reduced: boolean;
        readonly overflow: boolean;
        readonly spineWidth: number;
      }>(`
      return {
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        spineWidth: document.querySelector(".data-spine").getBoundingClientRect().width,
      };
    `),
    ).toEqual({ reduced: true, overflow: false, spineWidth: 48 });
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 30_000);
});
