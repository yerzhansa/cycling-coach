import { createServer } from "node:net";
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

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

const script: DesktopFixtureScript = {
  onRequest(value) {
    const request = value as ScriptRequest;
    if (request.method === "getRuntimeConfig") {
      return response({
        schemaVersion: 3,
        llm: {
          provider: "anthropic",
          model: "fixture",
          credential_configured: true,
        },
        intervals: {
          athlete_id: "0",
          credential_configured: false,
          managedByEnvironment: { athleteId: false },
        },
        session: {
          historyTokenBudgetRatio: 0.3,
          idleMinutes: 0,
          dailyResetHour: 4,
          timezone: "UTC",
        },
      });
    }
    if (request.method === "configureRuntime") {
      const params = request.params as {
        readonly llm?: unknown;
        readonly intervals?: unknown;
        readonly session?: unknown;
      };
      return response({
        schemaVersion: 3,
        status: "applied",
        applied: {
          llm: params.llm !== undefined,
          intervals: params.intervals !== undefined,
          session: params.session !== undefined,
        },
      });
    }
    if (request.method === "saveIntake") {
      return response({ schemaVersion: 1, saved: true });
    }
    if (request.method === "sync") {
      return response({
        schemaVersion: 1,
        published: false,
        referenceSucceeded: true,
        requests: { store: 0, reference: 0, total: 0 },
      });
    }
    if (request.method === "getAthleteState") {
      return response({
        schemaVersion: "1",
        lastUpdated: "1998-07-19T08:00:00.000Z",
        freshness: "fresh",
        degraded: false,
        lastSynced: null,
        athleteProfile: {},
        currentStatus: {},
        derivedMetrics: {},
        recentActivities: [],
        plannedWorkouts: [],
        wellness: {},
      });
    }
    if (request.method === "getTranscriptPage") {
      return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
    }
    if (request.method === "getUnitsPreference") {
      return response({ value: "metric", source: "default" });
    }
    if (request.method === "hasSession") {
      return response({ hasSession: false });
    }
    throw new TypeError(`unexpected fixture request: ${request.method}`);
  },
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("onboarding live", () => {
  it("opens Setup as a first-run page and finishes into a working chat", async () => {
    const fixture = await launchDesktopFixture({
      script,
      token,
      width: 1440,
      height: 900,
      colorScheme: "light",
      reducedMotion: false,
    });
    fixtures.push(fixture);
    const observed = await fixture.evaluate<{
      readonly present: boolean;
      readonly setupView: boolean;
      readonly scrimAbsent: boolean;
      readonly modalAbsent: boolean;
      readonly title: string;
      readonly escapeStayed: boolean;
      readonly finished: boolean;
      readonly chatWorking: boolean;
    }>(`
      const deadline = Date.now() + 10000;
      while (!document.querySelector(".onboarding") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const page = document.querySelector(".onboarding");
      const present = page !== null;
      const setupView =
        document.querySelector('[data-view="setup"][data-onboarding="open"]') !== null;
      const scrimAbsent = document.querySelector(".onboarding-scrim") === null;
      const modalAbsent =
        page?.getAttribute("role") !== "dialog" && page?.hasAttribute("aria-modal") !== true;
      const title = document.querySelector("#onboarding-title")?.textContent ?? "";
      page?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const escapeStayed =
        document.querySelector('[data-view="setup"][data-onboarding="open"]') !== null &&
        document.querySelector(".onboarding") !== null;
      const button = (label) =>
        Array.from(document.querySelectorAll(".onboarding button")).find(
          (entry) => entry.textContent?.trim() === label,
        );
      const waitForTitle = async (expected) => {
        const stepDeadline = Date.now() + 10000;
        while (
          document.querySelector("#onboarding-title")?.textContent !== expected &&
          Date.now() < stepDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const anthropic = document.querySelector('input[data-slot="anthropic"]');
      if (anthropic) anthropic.value = "synthetic-model-key";
      button("Continue")?.click();
      await waitForTitle("Bring your riding history");
      const intervals = document.querySelector('input[data-slot="intervals-icu"]');
      if (intervals) intervals.value = "synthetic-training-key";
      button("Continue")?.click();
      await waitForTitle("A few safety checks");
      const labels = Array.from(document.querySelectorAll(".onboarding label"));
      labels.find((entry) => entry.textContent?.trim() === "No")?.querySelector("input")?.click();
      labels
        .find((entry) => entry.textContent?.trim() === "No current injury")
        ?.querySelector("input")
        ?.click();
      button("Continue")?.click();
      await waitForTitle("Your coach is ready");
      button("Finish setup")?.click();
      const chatDeadline = Date.now() + 10000;
      while (
        document.querySelector(
          '[data-view="chat"][data-onboarding="closed"] textarea#message',
        ) === null &&
        Date.now() < chatDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const composer = document.querySelector(
        '[data-view="chat"][data-onboarding="closed"] textarea#message',
      );
      return {
        present,
        setupView,
        scrimAbsent,
        modalAbsent,
        title,
        escapeStayed,
        finished: document.querySelector(".onboarding") === null,
        chatWorking: composer !== null && composer.disabled === false,
      };
    `);
    expect(observed).toEqual({
      present: true,
      setupView: true,
      scrimAbsent: true,
      modalAbsent: true,
      title: "Choose how your coach thinks",
      escapeStayed: true,
      finished: true,
      chatWorking: true,
    });
  });
});
