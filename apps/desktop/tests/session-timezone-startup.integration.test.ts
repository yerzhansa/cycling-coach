import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
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

const token = "z".repeat(43);
const fixtures: RunningDesktopFixture[] = [];

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function makeScript(): DesktopFixtureScript {
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: { provider: "anthropic", model: "fixture", credential_configured: true },
          intervals: {
            athlete_id: "0",
            credential_configured: false,
            managedByEnvironment: { athleteId: false },
          },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
            managedByEnvironment: {
              historyTokenBudgetRatio: false,
              idleMinutes: false,
              dailyResetHour: false,
              resetArchiveRetentionDays: false,
              timezone: false,
            },
          },
        });
      }
      if (request.method === "getSetupStatus") {
        return response({
          schemaVersion: 1,
          intake: {
            swim_skill_floor: null,
            continuous_distance_capable: null,
            open_water_comfort: null,
            prior_bsi: false,
            clinician_cleared: null,
            injury_status: "none",
          },
          durableTrainingData: true,
        });
      }
      if (request.method === "getTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "listArchivedConversations") {
        return response({ schemaVersion: 1, conversations: [], nextCursor: null });
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: "metric", source: "default" });
      }
      if (request.method === "hasSession") {
        return response({ hasSession: false });
      }
      if (request.method === "getSpendSummary") {
        return response({
          schemaVersion: 1,
          currency: "USD",
          today: { spend: 0, cap: null },
          routes: [],
        });
      }
      return response({ schemaVersion: 1 });
    },
  };
}

async function launch(input: {
  readonly seedConfig: boolean;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<RunningDesktopFixture> {
  const fixture = await launchDesktopFixture({
    script: makeScript(),
    token,
    width: 1180,
    height: 840,
    colorScheme: "light",
    reducedMotion: true,
    sessionTimezoneMode: null,
    seedConfig: input.seedConfig,
    ...(input.extraEnv === undefined ? {} : { extraEnv: input.extraEnv }),
  });
  fixtures.push(fixture);
  return fixture;
}

async function persistedMode(fixture: RunningDesktopFixture): Promise<string | "absent"> {
  try {
    const contents = await readFile(fixture.paths.sessionTimezoneModePath, "utf8");
    return String((JSON.parse(contents) as { mode?: unknown }).mode);
  } catch {
    return "absent";
  }
}

async function storedZone(fixture: RunningDesktopFixture): Promise<string | "absent"> {
  try {
    const document = parseYaml(await readFile(fixture.paths.configPath, "utf8")) as {
      readonly session?: { readonly timezone?: unknown };
    };
    return String(document.session?.timezone);
  } catch {
    return "absent";
  }
}

async function noticeStatus(fixture: RunningDesktopFixture): Promise<string> {
  const raw = await fixture.evaluate<string>(
    "return JSON.stringify(await window.enduragentAuth.sessionTimezoneNotice());",
  );
  return String((JSON.parse(raw) as { status?: unknown }).status);
}

async function settingStatus(fixture: RunningDesktopFixture): Promise<{
  readonly status: string;
  readonly mode?: unknown;
}> {
  const raw = await fixture.evaluate<string>(
    "return JSON.stringify(await window.enduragentAuth.sessionTimezoneSetting());",
  );
  return JSON.parse(raw) as { status: string; mode?: unknown };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "desktop session timezone startup",
  () => {
    it("seeds a fresh profile without persisting any timezone source when COACH_TZ owns the zone", async () => {
      const fixture = await launch({
        seedConfig: false,
        extraEnv: { COACH_TZ: "Europe/Berlin" },
      });

      expect(await storedZone(fixture)).not.toBe("absent");
      expect(await persistedMode(fixture)).toBe("absent");
      expect(await noticeStatus(fixture)).toBe("none");
      const setting = await settingStatus(fixture);
      expect(setting.status).toBe("environment-managed");
    });

    it("defaults a fresh profile to following this computer when COACH_TZ is unset", async () => {
      const fixture = await launch({ seedConfig: false });

      expect(await storedZone(fixture)).not.toBe("absent");
      expect(await persistedMode(fixture)).toBe("follow");
      expect(await noticeStatus(fixture)).toBe("none");
      const setting = await settingStatus(fixture);
      expect(setting.status).toBe("editable");
      expect(setting.mode).toBe("follow");
    });

    it("leaves an existing config and its unanswered source alone when COACH_TZ owns the zone", async () => {
      const fixture = await launch({
        seedConfig: true,
        extraEnv: { COACH_TZ: "Europe/Berlin" },
      });

      expect(await storedZone(fixture)).toBe("UTC");
      expect(await persistedMode(fixture)).toBe("absent");
      expect(await noticeStatus(fixture)).toBe("none");
    });
  },
);
