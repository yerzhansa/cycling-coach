import { describe, it, expect } from "vitest";

import {
  EXIT_SUCCESS,
  EXIT_AGENT_ERROR,
  EXIT_USAGE,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_NOT_CONFIGURED,
  EXIT_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  TurnEventSchema,
  AthleteStateSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  ResetSessionResponseSchema,
  HasSessionResponseSchema,
  type CoachEngine,
} from "../src/index.js";

const TURN_ID = "b8b6c1a2-0000-4000-8000-000000000001";

const errorEvent = {
  type: "error",
  turnId: TURN_ID,
  chatId: "telegram:12345",
  error_class: "rate_limit",
  kind: "rate_limit",
  athleteMessage: "Rate limited — please try again in 30 seconds.",
  overflowAttempts: 0,
  timeoutAttempts: 0,
  rateLimitAttempts: 2,
  duration_ms: 4200,
  compactions: 0,
} as const;

const validState = {
  schemaVersion: "3",
  lastUpdated: "1998-07-06T09:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "1998-07-05T18:30:00.000Z",
  athleteProfile: { name: "Test Athlete" },
  currentStatus: { summary: "ready" },
  derivedMetrics: {
    monotony: 1.2,
    strain: 350,
    eftp: 250,
    "capability.hrrc": { note: "ok" },
    some_future_metric: 1,
  },
  derivedMetricsMeta: {
    sportFamily: "cycling",
    prescriptionBasis: "power",
    anchorType: "ftp",
    analysisBasis: "power",
  },
  recentActivities: [],
  plannedWorkouts: [],
  wellness: { restingHr: 45 },
} as const;

function cloneState(): Record<string, unknown> {
  return structuredClone(validState) as unknown as Record<string, unknown>;
}

describe("exit codes", () => {
  it("the six constants equal 0..5 exactly", () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_AGENT_ERROR).toBe(1);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_DAEMON_UNAVAILABLE).toBe(3);
    expect(EXIT_NOT_CONFIGURED).toBe(4);
    expect(EXIT_VERSION_MISMATCH).toBe(5);
  });
});

describe("protocol version", () => {
  it("is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("TurnEvent", () => {
  it("accepts every variant", () => {
    const samples = [
      { type: "turn-start", turnId: TURN_ID, chatId: "telegram:12345" },
      { type: "tool-start", turnId: TURN_ID, toolName: "intervals_create_workout" },
      {
        type: "tool-end",
        turnId: TURN_ID,
        toolName: "intervals_create_workout",
        summary: "created a workout on the calendar",
      },
      { type: "step-text", turnId: TURN_ID, text: "Looking at your recent rides..." },
      { type: "final-text", turnId: TURN_ID, text: "Here is this week's plan." },
      errorEvent,
      { type: "text_delta", turnId: TURN_ID, delta: "wor" },
    ];
    for (const sample of samples) {
      expect(TurnEventSchema.parse(sample)).toEqual(sample);
    }
  });

  it("rejects an unknown tag", () => {
    expect(TurnEventSchema.safeParse({ type: "turn-end", turnId: "x" }).success).toBe(false);
  });

  it("variants are closed (strict)", () => {
    const withExtra = {
      type: "final-text",
      turnId: TURN_ID,
      text: "done",
      extra: "nope",
    };
    expect(TurnEventSchema.safeParse(withExtra).success).toBe(false);
  });

  it("rejects camelCase spellings of the frozen field names", () => {
    const { error_class: _ec, duration_ms: _dm, ...rest } = errorEvent;
    const camelCased = { ...rest, errorClass: "rate_limit", durationMs: 4200 };
    expect(TurnEventSchema.safeParse(camelCased).success).toBe(false);
  });

  it("text_delta is parseable today", () => {
    const sample = { type: "text_delta", turnId: TURN_ID, delta: "wor" };
    expect(TurnEventSchema.parse(sample)).toEqual(sample);
  });
});

describe("AthleteState", () => {
  it("accepts a representative full state", () => {
    expect(AthleteStateSchema.parse(validState)).toEqual(validState);
  });

  it("accepts lastSynced null", () => {
    const state = cloneState();
    state["lastSynced"] = null;
    expect(AthleteStateSchema.parse(state)).toEqual(state);
  });

  it("reveal fence — acwr: a state carrying the fenced key fails to parse", () => {
    const state = cloneState();
    (state["derivedMetrics"] as Record<string, unknown>)["acwr"] = 1.3;
    expect(AthleteStateSchema.safeParse(state).success).toBe(false);
  });

  it("reveal fence — capability.dfa_a1_profile: a state carrying the fenced key fails to parse", () => {
    const state = cloneState();
    (state["derivedMetrics"] as Record<string, unknown>)["capability.dfa_a1_profile"] = {};
    expect(AthleteStateSchema.safeParse(state).success).toBe(false);
  });

  it("derivedMetricsMeta is strict", () => {
    const withExtraKey = cloneState();
    (withExtraKey["derivedMetricsMeta"] as Record<string, unknown>)["extra"] = 1;
    expect(AthleteStateSchema.safeParse(withExtraKey).success).toBe(false);

    const withBadAnchor = cloneState();
    (withBadAnchor["derivedMetricsMeta"] as Record<string, unknown>)["anchorType"] = "threshold";
    expect(AthleteStateSchema.safeParse(withBadAnchor).success).toBe(false);
  });

  it("envelope is strict", () => {
    const state = cloneState();
    state["unknownTopLevel"] = 1;
    expect(AthleteStateSchema.safeParse(state).success).toBe(false);
  });
});

describe("ChatRequest", () => {
  it("parses with and without turn, rejects unknown keys", () => {
    expect(
      ChatRequestSchema.safeParse({ chatId: "telegram:12345", message: "hi" }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: { resolvedCs: null },
      }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: { resolvedCs: { cs: 3.2 } },
      }).success,
    ).toBe(true);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        chatId: "telegram:12345",
        message: "hi",
        turn: { resolvedCs: null, extra: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("responses", () => {
  it("ChatResponse parses its valid sample and rejects an extra key", () => {
    expect(ChatResponseSchema.safeParse({ text: "ok" }).success).toBe(true);
    expect(ChatResponseSchema.safeParse({ text: "ok", extra: 1 }).success).toBe(false);
  });

  it("ResetSessionResponse parses its valid sample and rejects an extra key", () => {
    expect(ResetSessionResponseSchema.safeParse({ memoryFlushed: true }).success).toBe(true);
    expect(
      ResetSessionResponseSchema.safeParse({ memoryFlushed: true, extra: 1 }).success,
    ).toBe(false);
  });

  it("HasSessionResponse parses its valid sample and rejects an extra key", () => {
    expect(HasSessionResponseSchema.safeParse({ hasSession: false }).success).toBe(true);
    expect(HasSessionResponseSchema.safeParse({ hasSession: false, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("CoachEngine", () => {
  it("is implementable", async () => {
    const fake: CoachEngine = {
      chat: async () => ({ text: "" }),
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
      getAthleteState: async () => AthleteStateSchema.parse(validState),
    };
    await expect(fake.chat({ chatId: "telegram:12345", message: "hi" })).resolves.toEqual({
      text: "",
    });
  });
});
