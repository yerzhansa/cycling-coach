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

type SyncOutcome = "no-change" | "partial";

function makeScript(calls: ScriptRequest[], syncOutcome: SyncOutcome): DesktopFixtureScript {
  let units: "metric" | "imperial" = "metric";
  let hasSession = false;
  let lastSynced: string = athleteState.lastSynced;
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      calls.push(request);
      if (request.method === "getAthleteState") {
        return response({ ...athleteState, lastSynced });
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: units, source: units === "metric" ? "default" : "cycling" });
      }
      if (request.method === "setUnitsPreference") {
        units = (request.params as { readonly value: "metric" | "imperial" }).value;
        return response({ value: units, source: "cycling" });
      }
      if (request.method === "chat") {
        hasSession = true;
        const firstDelta = "## Today’s ride\n\nHold   **ste";
        const finalText = `${firstDelta}ady**.

<script>globalThis.hostile = true</script>

| Segment | Prescription |
| --- | --- |
| Endurance | ${"steady".repeat(40)} |

\`\`\`text
${"nonwrapping".repeat(36)}
\`\`\`

[Guide](https://example.test/guide)`;
        return [
          JSON.stringify({
            type: "text_delta",
            turnId: "turn-fixture",
            delta: firstDelta,
          }),
          JSON.stringify({
            type: "text_delta",
            turnId: "turn-fixture",
            delta: finalText.slice(firstDelta.length),
          }),
          JSON.stringify({ type: "final-text", turnId: "turn-fixture", text: finalText }),
          JSON.stringify({ text: finalText }),
        ];
      }
      if (request.method === "hasSession") return response({ hasSession });
      if (request.method === "resetSession") {
        hasSession = false;
        return response({ memoryFlushed: true });
      }
      if (request.method === "sync") {
        lastSynced = "2026-07-19T07:55:01.000Z";
        const partial = syncOutcome === "partial";
        return [
          JSON.stringify({ phase: "started", completed: 0, total: 1 }),
          JSON.stringify({ phase: "completed", completed: 1, total: 1 }),
          JSON.stringify({
            schemaVersion: 1,
            published: partial,
            referenceSucceeded: !partial,
            requests: { store: 1, reference: 1, total: 2 },
          }),
        ];
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
  readonly syncOutcome?: SyncOutcome;
}): Promise<{ readonly fixture: RunningDesktopFixture; readonly calls: ScriptRequest[] }> {
  const calls: ScriptRequest[] = [];
  const fixture = await launchDesktopFixture({
    script: makeScript(calls, input.syncOutcome ?? "no-change"),
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
  it("preserves IME composition until committed Enter", async () => {
    const { fixture, calls } = await launch({ width: 1440, height: 900, reducedMotion: false });
    const composingDraft = "回復走を";
    const composingEnter = await fixture.evaluate<{
      readonly isComposing: boolean;
      readonly dispatchResult: boolean;
      readonly defaultPrevented: boolean;
      readonly text: string;
      readonly focused: boolean;
      readonly chatStateUnchanged: boolean;
      readonly transcriptUnchanged: boolean;
      readonly liveRegionUnchanged: boolean;
      readonly athleteRows: number;
      readonly quickActionClicks: number;
    }>(`
      const textarea = document.querySelector("#message");
      const submit = document.querySelector('.composer button[type="submit"]');
      const conversation = document.querySelector(".conversation");
      const transcript = document.querySelector(".chat-transcript");
      const liveRegion = document.querySelector(".new-conversation-status");
      const quickActions = [...document.querySelectorAll(".coaching-shortcut")];
      let quickActionClicks = 0;
      const recordQuickActionClick = () => {
        quickActionClicks += 1;
      };
      for (const quickAction of quickActions) {
        quickAction.addEventListener("click", recordQuickActionClick);
      }
      textarea.value = ${JSON.stringify(composingDraft)};
      textarea.focus();
      const chatStateBefore = JSON.stringify({
        status: conversation.dataset.chatStatus,
        textareaDisabled: textarea.disabled,
        submitDisabled: submit.disabled,
      });
      const transcriptBefore = JSON.stringify({
        html: transcript.innerHTML,
        ariaLive: transcript.getAttribute("aria-live"),
        ariaRelevant: transcript.getAttribute("aria-relevant"),
        ariaAtomic: transcript.getAttribute("aria-atomic"),
      });
      const liveRegionBefore = JSON.stringify({
        html: liveRegion.innerHTML,
        role: liveRegion.getAttribute("role"),
        ariaLive: liveRegion.getAttribute("aria-live"),
      });
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      const dispatchResult = textarea.dispatchEvent(event);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const quickAction of quickActions) {
        quickAction.removeEventListener("click", recordQuickActionClick);
      }
      return {
        isComposing: event.isComposing,
        dispatchResult,
        defaultPrevented: event.defaultPrevented,
        text: textarea.value,
        focused: document.activeElement === textarea,
        chatStateUnchanged:
          JSON.stringify({
            status: conversation.dataset.chatStatus,
            textareaDisabled: textarea.disabled,
            submitDisabled: submit.disabled,
          }) === chatStateBefore,
        transcriptUnchanged:
          JSON.stringify({
            html: transcript.innerHTML,
            ariaLive: transcript.getAttribute("aria-live"),
            ariaRelevant: transcript.getAttribute("aria-relevant"),
            ariaAtomic: transcript.getAttribute("aria-atomic"),
          }) === transcriptBefore,
        liveRegionUnchanged:
          JSON.stringify({
            html: liveRegion.innerHTML,
            role: liveRegion.getAttribute("role"),
            ariaLive: liveRegion.getAttribute("aria-live"),
          }) === liveRegionBefore,
        athleteRows: document.querySelectorAll(".chat-message--athlete").length,
        quickActionClicks,
      };
    `);
    expect(composingEnter).toEqual({
      isComposing: true,
      dispatchResult: true,
      defaultPrevented: false,
      text: composingDraft,
      focused: true,
      chatStateUnchanged: true,
      transcriptUnchanged: true,
      liveRegionUnchanged: true,
      athleteRows: 0,
      quickActionClicks: 0,
    });
    expect(calls.filter((call) => call.method === "chat")).toHaveLength(0);

    const committedMessage = "回復走を30分します。";
    const committedEnter = await fixture.evaluate<{
      readonly isComposing: boolean;
      readonly dispatchResult: boolean;
      readonly defaultPrevented: boolean;
      readonly athleteMessages: readonly string[];
      readonly quickActionClicks: number;
    }>(`
      const textarea = document.querySelector("#message");
      const quickActions = [...document.querySelectorAll(".coaching-shortcut")];
      let quickActionClicks = 0;
      const recordQuickActionClick = () => {
        quickActionClicks += 1;
      };
      for (const quickAction of quickActions) {
        quickAction.addEventListener("click", recordQuickActionClick);
      }
      textarea.value = ${JSON.stringify(committedMessage)};
      const conversation = document.querySelector(".conversation");
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      const dispatchResult = textarea.dispatchEvent(event);
      const deadline = Date.now() + 5000;
      while (conversation.dataset.chatStatus === "streaming" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      for (const quickAction of quickActions) {
        quickAction.removeEventListener("click", recordQuickActionClick);
      }
      return {
        isComposing: event.isComposing,
        dispatchResult,
        defaultPrevented: event.defaultPrevented,
        athleteMessages: [...document.querySelectorAll(".chat-message--athlete")].map(
          (row) => row.querySelector(".chat-message__text")?.textContent ?? "",
        ),
        quickActionClicks,
      };
    `);
    expect(committedEnter).toEqual({
      isComposing: false,
      dispatchResult: false,
      defaultPrevented: true,
      athleteMessages: [committedMessage],
      quickActionClicks: 0,
    });
    expect(calls.filter((call) => call.method === "chat")).toEqual([
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: committedMessage },
      },
    ]);
  }, 30_000);

  it("streams chat, proves no-change sync, preserves focus, and fits desktop geometry", async () => {
    const { fixture, calls } = await launch({ width: 1440, height: 900, reducedMotion: false });
    const initial = await fixture.evaluate<{
      readonly location: string;
      readonly bridgeKeys: readonly string[];
      readonly thread: boolean;
      readonly partial: string;
      readonly final: string;
      readonly athleteStable: boolean;
      readonly coachStable: boolean;
      readonly busyObserved: boolean;
      readonly busyCleared: boolean;
      readonly partialWhiteSpace: string | null;
      readonly partialSourcePreserved: boolean;
      readonly controlExercised: boolean;
      readonly controlOnlyMutations: number;
      readonly heading: string;
      readonly strong: string;
      readonly hostileTextVisible: boolean;
      readonly hostileElementCount: number;
      readonly link: {
        readonly href: string | null;
        readonly target: string | null;
        readonly rel: string | null;
        readonly referrerPolicy: string | null;
      };
      readonly drawerStatus: string;
      readonly anchorValue: string;
      readonly wellnessValue: string;
      readonly documentOverflow: boolean;
    }>(`
      const bridgeKeys = Object.keys(window.enduragentAuth).sort();
      const thread = document.querySelectorAll(".thread").length === 1;
      const textarea = document.querySelector("#message");
      const observed = [];
      let athleteRow;
      let coachRow;
      let athleteStable = true;
      let coachStable = true;
      let busyObserved = false;
      let busyCleared = false;
      let partialWhiteSpace = null;
      let partialSourcePreserved = false;
      const capturePartial = (candidate) => {
        if (!candidate.includes("Hold   **ste") || candidate.includes("ady**")) return;
        partialSourcePreserved =
          candidate.startsWith("## Today’s ride") &&
          candidate.includes(String.fromCharCode(10) + String.fromCharCode(10));
        partialWhiteSpace = getComputedStyle(
          document.querySelector(".chat-message--coach .chat-message__text"),
        ).whiteSpace;
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData" && record.oldValue) {
            observed.push(record.oldValue);
            capturePartial(record.oldValue);
          }
          if (record.type === "attributes" && record.attributeName === "aria-busy" && record.oldValue === "true") {
            busyObserved = true;
          }
        }
        const value = document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
        if (value.length > 0) {
          observed.push(value);
          capturePartial(value);
        }
        const currentAthlete = document.querySelector(".chat-message--athlete");
        const currentCoach = document.querySelector(".chat-message--coach");
        if (currentAthlete && athleteRow && currentAthlete !== athleteRow) athleteStable = false;
        if (currentCoach && coachRow && currentCoach !== coachRow) coachStable = false;
        athleteRow ??= currentAthlete;
        coachRow ??= currentCoach;
        if (currentCoach?.getAttribute("aria-busy") === "true") busyObserved = true;
        if (busyObserved && currentCoach && !currentCoach.hasAttribute("aria-busy")) busyCleared = true;
      });
      observer.observe(document.querySelector(".chat-messages"), {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["aria-busy"],
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        subtree: true,
      });
      textarea.value = "What should I ride?";
      textarea.closest("form").requestSubmit();
      athleteRow ??= document.querySelector(".chat-message--athlete");
      const finalDeadline = Date.now() + 5000;
      let final = "";
      while (Date.now() < finalDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const currentCoach = document.querySelector(".chat-message--coach");
        final = currentCoach?.querySelector(".chat-message__text")?.textContent ?? "";
        if (
          final.includes("<script>globalThis.hostile = true</script>") &&
          final.includes("Guide") &&
          !currentCoach?.hasAttribute("aria-busy")
        ) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      observer.disconnect();
      const partial = observed.find(
        (value) => value.includes("Hold   **ste") && !value.includes("ady**"),
      ) ?? "";
      const opener = document.querySelector(".new-conversation-button");
      const controlDeadline = Date.now() + 5000;
      while (
        (opener.disabled || opener.getAttribute("aria-disabled") === "true") &&
        Date.now() < controlDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const controlRecords = [];
      const controlObserver = new MutationObserver((records) => controlRecords.push(...records));
      controlObserver.observe(document.querySelector(".chat-messages"), {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      const controlExercised = !opener.disabled && opener.getAttribute("aria-disabled") !== "true";
      if (controlExercised) {
        opener.click();
        document.querySelector(".new-conversation-dialog button")?.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      controlObserver.disconnect();
      const coach = document.querySelector(".chat-message--coach");
      const link = coach?.querySelector("a");
      const panels = [...document.querySelectorAll(".context-panel__body")];
      return {
        location: location.href,
        bridgeKeys,
        thread,
        partial,
        final,
        athleteStable: athleteStable && athleteRow === document.querySelector(".chat-message--athlete"),
        coachStable: coachStable && coachRow === coach,
        busyObserved,
        busyCleared,
        partialWhiteSpace,
        partialSourcePreserved,
        controlExercised,
        controlOnlyMutations: controlRecords.length,
        heading: coach?.querySelector("h2")?.textContent ?? "",
        strong: coach?.querySelector("strong")?.textContent ?? "",
        hostileTextVisible: coach?.textContent.includes("<script>globalThis.hostile = true</script>") ?? false,
        hostileElementCount: coach?.querySelectorAll("script, img").length ?? -1,
        link: {
          href: link?.getAttribute("href") ?? null,
          target: link?.getAttribute("target") ?? null,
          rel: link?.getAttribute("rel") ?? null,
          referrerPolicy: link?.getAttribute("referrerpolicy") ?? null,
        },
        drawerStatus: document.querySelector(".drawer-status")?.textContent ?? "missing",
        anchorValue: panels[0]?.querySelector(".context-panel__value")?.textContent ?? "",
        wellnessValue: panels[4]?.querySelector(".wellness-row__value")?.textContent ?? "",
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
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
      partial: "## Today’s ride\n\nHold   **ste",
      final: expect.stringContaining("<script>globalThis.hostile = true</script>"),
      athleteStable: true,
      coachStable: true,
      busyObserved: true,
      busyCleared: true,
      partialWhiteSpace: "pre-wrap",
      partialSourcePreserved: true,
      controlExercised: true,
      controlOnlyMutations: 0,
      heading: "Today’s ride",
      strong: "steady",
      hostileTextVisible: true,
      hostileElementCount: 0,
      link: {
        href: "https://example.test/guide",
        target: "_blank",
        rel: "noopener noreferrer",
        referrerPolicy: "no-referrer",
      },
      drawerStatus: "",
      anchorValue: "300 W",
      wellnessValue: "65 ms",
      documentOverflow: false,
    });
    expect(calls.filter((call) => call.method === "hasSession")).toEqual([
      {
        jsonrpc: "2.0",
        method: "hasSession",
        params: { chatId: "desktop" },
      },
    ]);
    const quickActions = await fixture.evaluate<{
      readonly groupLabel: string | null;
      readonly labels: readonly string[];
      readonly commands: readonly string[];
      readonly terminalResponses: number;
      readonly keyboardActivationDetail: number | null;
      readonly keyboardShortcutResidentAfterTerminal: boolean;
      readonly keyboardShortcutFocusedAfterTerminal: boolean;
      readonly draft: string;
      readonly documentOverflow: boolean;
      readonly composerHeight: number;
      readonly composerClearanceTracksHeight: boolean;
      readonly finalTranscriptClearsComposer: boolean;
    }>(`
      const group = document.querySelector(".coaching-shortcuts");
      const buttons = [...group.querySelectorAll(".coaching-shortcut")];
      const keyboardShortcut = buttons.at(-1);
      const textarea = document.querySelector("#message");
      textarea.value = "  keep draft\\n";
      let terminalResponses = 0;
      let keyboardActivationDetail = null;
      let keyboardShortcutResidentAfterTerminal = false;
      let keyboardShortcutFocusedAfterTerminal = false;
      keyboardShortcut.addEventListener("click", (event) => {
        keyboardActivationDetail = event.detail;
      }, { once: true });
      for (const button of buttons) {
        const readyDeadline = Date.now() + 5000;
        while (button.disabled && Date.now() < readyDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const coachCount = document.querySelectorAll(".chat-message--coach").length;
        if (button === keyboardShortcut) button.focus();
        button.click();
        const terminalDeadline = Date.now() + 5000;
        while (Date.now() < terminalDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const coaches = [...document.querySelectorAll(".chat-message--coach")];
          const latest = coaches.at(-1);
          if (coaches.length === coachCount + 1 && latest && !latest.hasAttribute("aria-busy")) {
            terminalResponses += 1;
            if (button === keyboardShortcut) {
              keyboardShortcutResidentAfterTerminal =
                [...group.querySelectorAll(".coaching-shortcut")].at(-1) === keyboardShortcut;
              keyboardShortcutFocusedAfterTerminal = document.activeElement === keyboardShortcut;
            }
            break;
          }
        }
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const conversation = document.querySelector(".conversation");
      const composer = document.querySelector(".composer-wrap");
      conversation.scrollTop = conversation.scrollHeight;
      const composerRect = composer.getBoundingClientRect();
      const finalTranscriptItem = [...document.querySelectorAll(".chat-message, .chat-notice, .chat-retry")]
        .filter((node) => !node.hidden)
        .at(-1);
      const reservedBottom = Number.parseFloat(getComputedStyle(conversation).paddingBottom);
      return {
        groupLabel: group.getAttribute("aria-label"),
        labels: buttons.map((button) => button.querySelector(".coaching-shortcut__label")?.textContent ?? ""),
        commands: buttons.map((button) => button.querySelector(".coaching-shortcut__command")?.textContent ?? ""),
        terminalResponses,
        keyboardActivationDetail,
        keyboardShortcutResidentAfterTerminal,
        keyboardShortcutFocusedAfterTerminal,
        draft: textarea.value,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        composerHeight: composerRect.height,
        composerClearanceTracksHeight: Math.abs(reservedBottom - composerRect.height) < 1,
        finalTranscriptClearsComposer:
          finalTranscriptItem.getBoundingClientRect().bottom <= composerRect.top + 1,
      };
    `);
    expect(quickActions).toEqual({
      groupLabel: "Coaching shortcuts",
      labels: ["Build a plan", "Today’s workout", "Training status", "Review last session"],
      commands: ["/plan", "/workout", "/status", "/review"],
      terminalResponses: 4,
      keyboardActivationDetail: 0,
      keyboardShortcutResidentAfterTerminal: true,
      keyboardShortcutFocusedAfterTerminal: true,
      draft: "  keep draft\n",
      documentOverflow: false,
      composerHeight: expect.any(Number),
      composerClearanceTracksHeight: true,
      finalTranscriptClearsComposer: true,
    });
    expect(quickActions.composerHeight).toBeGreaterThan(0);
    await fixture.setViewport(720, 800);
    const compact = await fixture.evaluate<{
      readonly documentOverflow: boolean;
      readonly tableScrollsLocally: boolean;
      readonly codeScrollsLocally: boolean;
      readonly shortcutsWrapped: boolean;
      readonly composerHeight: number;
      readonly composerClearanceTracksHeight: boolean;
      readonly finalTranscriptClearsComposer: boolean;
    }>(`
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tableScroll = document.querySelector(".chat-markdown__table-scroll");
        const codeBlock = document.querySelector(".chat-message--coach pre");
        const conversation = document.querySelector(".conversation");
        const composer = document.querySelector(".composer-wrap");
        const shortcutGroup = document.querySelector(".coaching-shortcuts");
        const firstShortcut = shortcutGroup.querySelector(".coaching-shortcut");
        conversation.scrollTop = conversation.scrollHeight;
        const composerRect = composer.getBoundingClientRect();
        const finalTranscriptItem = [...document.querySelectorAll(".chat-message, .chat-notice, .chat-retry")]
          .filter((node) => !node.hidden)
          .at(-1);
        const reservedBottom = Number.parseFloat(getComputedStyle(conversation).paddingBottom);
        return {
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          tableScrollsLocally: tableScroll.scrollWidth > tableScroll.clientWidth && getComputedStyle(tableScroll).overflowX === "auto",
          codeScrollsLocally: codeBlock.scrollWidth > codeBlock.clientWidth && getComputedStyle(codeBlock).overflowX === "auto",
          shortcutsWrapped: shortcutGroup.getBoundingClientRect().height > firstShortcut.getBoundingClientRect().height,
          composerHeight: composerRect.height,
          composerClearanceTracksHeight: Math.abs(reservedBottom - composerRect.height) < 1,
          finalTranscriptClearsComposer:
            finalTranscriptItem.getBoundingClientRect().bottom <= composerRect.top + 1,
        };
      `);
    expect(compact).toEqual({
      documentOverflow: false,
      tableScrollsLocally: true,
      codeScrollsLocally: true,
      shortcutsWrapped: true,
      composerHeight: expect.any(Number),
      composerClearanceTracksHeight: true,
      finalTranscriptClearsComposer: true,
    });
    expect(compact.composerHeight).toBeGreaterThan(quickActions.composerHeight);
    const reset = await fixture.evaluate<{
      readonly enabledBefore: boolean;
      readonly dialogOpen: boolean;
      readonly transcriptEmpty: boolean;
      readonly composerValue: string;
      readonly composerDisabled: boolean;
      readonly resetDisabled: boolean;
      readonly focused: string | null;
      readonly transcriptClearMutations: number;
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
      const clearRecords = [];
      const clearObserver = new MutationObserver((records) => clearRecords.push(...records));
      clearObserver.observe(document.querySelector(".chat-messages"), { childList: true });
      if (dialogOpen) dialog.querySelector(".new-conversation-dialog__confirm").click();
      const resetDeadline = Date.now() + 5000;
      while (dialog.open && Date.now() < resetDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearObserver.disconnect();
      return {
        enabledBefore,
        dialogOpen,
        transcriptEmpty: document.querySelectorAll(".chat-message").length === 0,
        composerValue: textarea.value,
        composerDisabled: textarea.disabled,
        resetDisabled: opener.disabled,
        focused: document.activeElement?.id ?? null,
        transcriptClearMutations: clearRecords.filter((record) => record.type === "childList").length,
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
      transcriptClearMutations: 1,
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
      readonly sync: {
        readonly buttonResident: boolean;
        readonly queued: string;
        readonly runningObserved: boolean;
        readonly terminal: string;
        readonly label: string;
        readonly atomicLiveRegion: boolean;
        readonly busyQueued: boolean;
        readonly busyCleared: boolean;
        readonly keyboardFocusRestored: boolean;
        readonly noChangeTerminalObservations: number;
        readonly noChangeTerminalOnlyAfterRefresh: boolean;
        readonly onlyLastSyncedChanged: boolean;
        readonly trainingPanelsUnchanged: boolean;
        readonly asOfUnchanged: boolean;
        readonly asOfBefore: string;
        readonly asOfAfter: string;
        readonly lastSyncedBefore: string;
        readonly lastSyncedAfter: string;
        readonly statusWraps: boolean;
        readonly buttonReachable: boolean;
        readonly drawerOverflow: boolean;
      };
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
      const syncButton = drawer.querySelector(".training-sync__button");
      const syncStatus = drawer.querySelector(".training-sync__status");
      const metadataText = () => [...drawer.querySelectorAll(".drawer-metadata__item")].map((node) => node.textContent ?? "");
      const metadataChildrenText = () => [...drawer.querySelector(".drawer-metadata").children].map((node) => node.textContent ?? "");
      const metadataBefore = metadataChildrenText();
      const panelsBefore = [...drawer.querySelectorAll(".context-panel__body")].map((node) => node.textContent ?? "");
      const asOfBefore = metadataText().find((value) => value.startsWith("As of ")) ?? "";
      const lastSyncedBefore = metadataText().find((value) => value.startsWith("Last synced ")) ?? "";
      const liveValues = [];
      const noChangeCopy = "Local training-data processing completed.";
      let noChangeTerminalObservations = 0;
      let noChangeTerminalBeforeRefresh = false;
      const liveObserver = new MutationObserver(() => {
        const value = syncStatus.textContent ?? "";
        liveValues.push(value);
        if (value === noChangeCopy) {
          noChangeTerminalObservations += 1;
          const currentLastSynced = metadataText().find((item) => item.startsWith("Last synced ")) ?? "";
          if (currentLastSynced === lastSyncedBefore) noChangeTerminalBeforeRefresh = true;
        }
      });
      liveObserver.observe(syncStatus, { childList: true, characterData: true, subtree: true });
      syncButton.focus();
      syncButton.click();
      const queued = syncStatus.textContent ?? "";
      const busyQueued = syncButton.disabled && syncButton.getAttribute("aria-busy") === "true";
      syncButton.click();
      syncButton.blur();
      const syncDeadline = Date.now() + 5000;
      while (syncButton.disabled && Date.now() < syncDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      liveObserver.disconnect();
      const asOfAfter = metadataText().find((value) => value.startsWith("As of ")) ?? "";
      const lastSyncedAfter = metadataText().find((value) => value.startsWith("Last synced ")) ?? "";
      const metadataAfter = metadataChildrenText();
      const panelsAfter = [...drawer.querySelectorAll(".context-panel__body")].map((node) => node.textContent ?? "");
      syncStatus.scrollIntoView({ block: "nearest" });
      const syncButtonRect = syncButton.getBoundingClientRect();
      const drawerRect = drawer.getBoundingClientRect();
      const syncResult = {
        buttonResident: syncButton === drawer.querySelector(".training-sync__button"),
        queued,
        runningObserved: liveValues.includes("Syncing training data…"),
        terminal: syncStatus.textContent ?? "",
        label: syncButton.textContent ?? "",
        atomicLiveRegion:
          syncStatus.getAttribute("role") === "status" &&
          syncStatus.getAttribute("aria-live") === "polite" &&
          syncStatus.getAttribute("aria-atomic") === "true",
        busyQueued,
        busyCleared: !syncButton.hasAttribute("aria-busy") && !syncButton.disabled,
        keyboardFocusRestored: document.activeElement === syncButton,
        noChangeTerminalObservations,
        noChangeTerminalOnlyAfterRefresh:
          noChangeTerminalObservations === 1 &&
          !noChangeTerminalBeforeRefresh &&
          lastSyncedAfter !== lastSyncedBefore,
        onlyLastSyncedChanged:
          metadataBefore.length === metadataAfter.length &&
          metadataBefore.filter((value, index) => value !== metadataAfter[index]).length === 1 &&
          metadataBefore.find((value) => value.startsWith("Last synced ")) === lastSyncedBefore &&
          metadataAfter.find((value) => value.startsWith("Last synced ")) === lastSyncedAfter,
        trainingPanelsUnchanged: JSON.stringify(panelsBefore) === JSON.stringify(panelsAfter),
        asOfUnchanged: asOfBefore === asOfAfter,
        asOfBefore,
        asOfAfter,
        lastSyncedBefore,
        lastSyncedAfter,
        statusWraps: syncStatus.scrollWidth <= syncStatus.clientWidth,
        buttonReachable:
          syncButtonRect.top >= drawerRect.top && syncButtonRect.bottom <= drawerRect.bottom,
        drawerOverflow: drawer.scrollWidth > drawer.clientWidth,
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
        sync: syncResult,
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
      sync: {
        buttonResident: true,
        queued: "Sync queued.",
        runningObserved: true,
        terminal: "Local training-data processing completed.",
        label: "Sync again",
        atomicLiveRegion: true,
        busyQueued: true,
        busyCleared: true,
        keyboardFocusRestored: true,
        noChangeTerminalObservations: 1,
        noChangeTerminalOnlyAfterRefresh: true,
        onlyLastSyncedChanged: true,
        trainingPanelsUnchanged: true,
        asOfUnchanged: true,
        asOfBefore: "As of 2026-07-19",
        asOfAfter: "As of 2026-07-19",
        lastSyncedBefore: "Last synced 2026-07-19 07:55:00 UTC",
        lastSyncedAfter: "Last synced 2026-07-19 07:55:01 UTC",
        statusWraps: true,
        buttonReachable: true,
        drawerOverflow: false,
      },
    });
    const syncCallIndex = calls.findIndex((call) => call.method === "sync");
    expect(syncCallIndex).toBeGreaterThan(-1);
    expect(calls.filter((call) => call.method === "sync")).toEqual([
      { jsonrpc: "2.0", method: "sync", params: {} },
    ]);
    expect(
      calls.slice(syncCallIndex + 1).filter((call) => call.method === "getAthleteState"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.method === "chat")).toEqual([
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "What should I ride?" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/plan" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/workout" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/status" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/review" },
      },
    ]);
    expect(calls.filter((call) => call.method === "setUnitsPreference")).toEqual([
      { jsonrpc: "2.0", method: "setUnitsPreference", params: { value: "imperial" } },
    ]);
    await fixture.setViewport(720, 800);
    const compactDrawerGeometry = await fixture.evaluate<{
      readonly documentOverflow: boolean;
      readonly topbarFits: boolean;
      readonly drawerOpen: boolean;
      readonly buttonResident: boolean;
      readonly buttonReachable: boolean;
      readonly noChangeStatus: boolean;
      readonly statusFits: boolean;
      readonly horizontalOverflow: boolean;
    }>(`
      const compactOpener = document.querySelector(".drawer-toggle");
      compactOpener.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const topbar = document.querySelector(".topbar");
      const compactDrawer = document.querySelector("#training-context-drawer");
      const compactButton = compactDrawer.querySelector(".training-sync__button");
      const compactStatus = compactDrawer.querySelector(".training-sync__status");
      const compactRegion = compactDrawer.querySelector(".training-sync");
      const drawerRect = compactDrawer.getBoundingClientRect();
      const buttonRect = compactButton.getBoundingClientRect();
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        topbarFits: topbar.scrollWidth <= topbar.clientWidth,
        drawerOpen: compactDrawer.open,
        buttonResident: compactDrawer.querySelectorAll(".training-sync__button").length === 1,
        buttonReachable:
          buttonRect.left >= drawerRect.left &&
          buttonRect.right <= drawerRect.right &&
          buttonRect.top >= drawerRect.top &&
          buttonRect.bottom <= Math.min(drawerRect.bottom, window.innerHeight),
        noChangeStatus: compactStatus.textContent === "Local training-data processing completed.",
        statusFits: compactStatus.scrollWidth <= compactStatus.clientWidth,
        horizontalOverflow:
          compactDrawer.scrollWidth > compactDrawer.clientWidth ||
          compactRegion.scrollWidth > compactRegion.clientWidth ||
          compactStatus.scrollWidth > compactStatus.clientWidth,
      };
    `);
    expect(compactDrawerGeometry).toEqual({
      documentOverflow: false,
      topbarFits: true,
      drawerOpen: true,
      buttonResident: true,
      buttonReachable: true,
      noChangeStatus: true,
      statusFits: true,
      horizontalOverflow: false,
    });
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

  it("keeps the long partial-sync status reachable and wrapped at 720×800", async () => {
    const { fixture, calls } = await launch({
      width: 720,
      height: 800,
      reducedMotion: false,
      syncOutcome: "partial",
    });
    const compact = await fixture.evaluate<{
      readonly drawerOpen: boolean;
      readonly buttonResident: boolean;
      readonly buttonReachable: boolean;
      readonly terminal: string;
      readonly label: string;
      readonly statusWrapped: boolean;
      readonly keyboardFocusRestored: boolean;
      readonly horizontalOverflow: boolean;
    }>(`
      const opener = document.querySelector(".drawer-toggle");
      opener.click();
      const drawer = document.querySelector("#training-context-drawer");
      const syncButton = drawer.querySelector(".training-sync__button");
      const syncStatus = drawer.querySelector(".training-sync__status");
      const syncRegion = drawer.querySelector(".training-sync");
      syncButton.focus();
      syncButton.click();
      syncButton.blur();
      const deadline = Date.now() + 5000;
      while (syncButton.disabled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      syncStatus.scrollIntoView({ block: "nearest" });
      const drawerRect = drawer.getBoundingClientRect();
      const buttonRect = syncButton.getBoundingClientRect();
      const statusRect = syncStatus.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(syncStatus).lineHeight);
      return {
        drawerOpen: drawer.open,
        buttonResident: drawer.querySelectorAll(".training-sync__button").length === 1,
        buttonReachable:
          buttonRect.left >= drawerRect.left &&
          buttonRect.right <= drawerRect.right &&
          buttonRect.top >= drawerRect.top &&
          buttonRect.bottom <= Math.min(drawerRect.bottom, window.innerHeight),
        terminal: syncStatus.textContent ?? "",
        label: syncButton.textContent ?? "",
        statusWrapped:
          statusRect.height >= lineHeight * 1.9 &&
          syncStatus.scrollWidth <= syncStatus.clientWidth,
        keyboardFocusRestored: document.activeElement === syncButton,
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          drawer.scrollWidth > drawer.clientWidth ||
          syncRegion.scrollWidth > syncRegion.clientWidth ||
          syncStatus.scrollWidth > syncStatus.clientWidth,
      };
    `);
    expect(compact).toEqual({
      drawerOpen: true,
      buttonResident: true,
      buttonReachable: true,
      terminal: "Training-data processing partially completed. Try again to finish.",
      label: "Try again",
      statusWrapped: true,
      keyboardFocusRestored: true,
      horizontalOverflow: false,
    });
    const syncCallIndex = calls.findIndex((call) => call.method === "sync");
    expect(syncCallIndex).toBeGreaterThan(-1);
    expect(calls.filter((call) => call.method === "sync")).toEqual([
      { jsonrpc: "2.0", method: "sync", params: {} },
    ]);
    expect(
      calls.slice(syncCallIndex + 1).filter((call) => call.method === "getAthleteState"),
    ).toHaveLength(1);
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
