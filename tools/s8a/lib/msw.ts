import { http, HttpResponse } from "msw";

import {
  createMockIntervalsServer,
  type CreatedWorkout,
} from "../../../packages/core/tests/helpers/mock-intervals.js";
import { providerLane } from "./provider-lane.js";
import type { S8aProvider, S8aScenario } from "./types.js";

export interface IntervalsMockHandle {
  server: ReturnType<typeof createMockIntervalsServer>["server"];
  createdWorkouts: CreatedWorkout[];
  deletedEventIds: number[];
  leak: { detected: boolean; firstUrl?: string };
  close(): void;
}

/** In record mode the real model call is routed around MSW's global fetch
 *  interception; everything else off the intervals mock is a leak. In replay
 *  mode there is no legitimate unhandled request at all. */
export function classifyUnhandled(
  url: string,
  mode: "replay" | "record",
  provider: S8aProvider,
): "bypass" | "leak" {
  if (mode === "record") {
    try {
      if (providerLane(provider).recordBypassHosts.includes(new URL(url).host)) return "bypass";
    } catch {
      // Unparseable URL: treat as a leak.
    }
  }
  return "leak";
}

export function requestUrlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === "string" ? url : "";
}

export function routeModelHostAroundMsw(params: {
  passthrough: typeof globalThis.fetch;
  intercepted: typeof globalThis.fetch;
  provider: S8aProvider;
}): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const target =
      classifyUnhandled(requestUrlOf(input), "record", params.provider) === "bypass"
        ? params.passthrough
        : params.intercepted;
    return target(input, init);
  }) as typeof globalThis.fetch;
}

export function startIntervalsMock(
  scenario: S8aScenario,
  mode: "replay" | "record",
  provider: S8aProvider,
): IntervalsMockHandle {
  const { server, createdWorkouts, deletedEventIds } = createMockIntervalsServer(
    scenario.intervals,
  );

  // Supplementary route: the shared helper registers only athlete-scoped
  // routes, but the single-activity client fetches /api/v1/activity/{id}.
  // Served from the same explicit `activities` section the record validation
  // already mandates for that tool.
  server.use(
    http.get("https://intervals.icu/api/v1/activity/:id", ({ params }) => {
      const id = Number(params.id);
      const entry = (scenario.intervals.activities ?? []).find((a) => a.id === id);
      if (entry === undefined) {
        return HttpResponse.json({ error: "not_found" }, { status: 404 });
      }
      return HttpResponse.json(entry);
    }),
  );

  const leak: IntervalsMockHandle["leak"] = { detected: false };
  const markLeak = (url: string) => {
    if (!leak.detected) {
      leak.detected = true;
      leak.firstUrl = url;
    }
  };

  const passthroughFetch = globalThis.fetch;
  let restoreFetch: (() => void) | undefined;

  if (mode === "replay") {
    server.events.on("request:unhandled", ({ request }) => {
      markLeak(request.url);
    });
    server.listen({ onUnhandledRequest: "error" });
  } else {
    server.listen({
      onUnhandledRequest: (request, print) => {
        if (classifyUnhandled(request.url, "record", provider) === "bypass") return;
        markLeak(request.url);
        print.error();
      },
    });
    const intercepted = globalThis.fetch;
    const routed = routeModelHostAroundMsw({
      passthrough: passthroughFetch,
      intercepted,
      provider,
    });
    globalThis.fetch = routed;
    restoreFetch = () => {
      if (globalThis.fetch === routed) globalThis.fetch = intercepted;
    };
  }

  return {
    server,
    createdWorkouts,
    deletedEventIds,
    leak,
    close: () => {
      restoreFetch?.();
      server.close();
    },
  };
}
