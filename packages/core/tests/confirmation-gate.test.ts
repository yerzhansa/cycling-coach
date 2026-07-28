import { describe, expect, it, vi } from "vitest";
import { tool, zodSchema } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import type { IntervalsClient } from "intervals-icu-api";
import {
  ConfirmationGate,
  GATED_TOOL_NAMES,
  PROPOSAL_TTL_MS,
  createProposalSummarizers,
  gateMutatingTool,
} from "../src/agent/confirmation-gate.js";
import { READ_ONLY_TOOL_NAMES } from "../src/agent/read-memoizer.js";
import { createPureCoreIntervalsTools } from "../src/agent/intervals-tools.js";
import { COACH_EVENT_TAG } from "../src/agent/event-provenance.js";

function fakeTool(execute: (input: unknown) => unknown): Tool {
  return tool({ inputSchema: zodSchema(z.object({}).passthrough()), execute });
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: "Fetched truth",
    category: "WORKOUT",
    startDateLocal: "2999-01-02T00:00:00",
    tags: [COACH_EVENT_TAG],
    ...overrides,
  };
}

function fakeIntervals(initial = event()): {
  client: IntervalsClient;
  setEvent: (next: Record<string, unknown>) => void;
  gets: ReturnType<typeof vi.fn>;
  deletes: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const gets = vi.fn(async () => ({ ok: true, value: current }));
  const deletes = vi.fn(async () => ({ ok: true, value: undefined }));
  return {
    client: { events: { get: gets, delete: deletes } } as unknown as IntervalsClient,
    setEvent: (next) => {
      current = next;
    },
    gets,
    deletes,
  };
}

describe("ConfirmationGate", () => {
  it("stores, replaces, confirms once, and rejects mismatches", async () => {
    const gate = new ConfirmationGate();
    const firstRun = vi.fn(async () => "first");
    gate.propose("chat", "first summary", firstRun);
    const first = gate.peek("chat")!;
    expect(first.summary).toBe("first summary");

    const secondRun = vi.fn(async () => ({ ok: true }));
    gate.propose("chat", "second summary", secondRun);
    const second = gate.peek("chat")!;
    expect(second.nonce).not.toBe(first.nonce);
    expect(await gate.confirm("chat", first.nonce)).toEqual({ status: "mismatch" });
    expect(firstRun).not.toHaveBeenCalled();
    expect(await gate.confirm("chat", second.nonce)).toEqual({
      status: "executed",
      summary: "second summary",
      result: { ok: true },
    });
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(await gate.confirm("chat", second.nonce)).toEqual({ status: "none" });
  });

  it("expires lazily at the TTL", async () => {
    let now = 100;
    const gate = new ConfirmationGate(() => now);
    gate.propose("chat", "summary", async () => true);
    const nonce = gate.peek("chat")!.nonce;
    now += PROPOSAL_TTL_MS;
    expect(gate.peek("chat")).toBeUndefined();
    expect(await gate.confirm("chat", nonce)).toEqual({ status: "none" });
  });

  it("reports expired when confirm performs the lazy prune", async () => {
    let now = 0;
    const gate = new ConfirmationGate(() => now);
    gate.propose("chat", "summary", async () => true);
    const nonce = gate.peek("chat")!.nonce;
    now = PROPOSAL_TTL_MS;
    expect(await gate.confirm("chat", nonce)).toEqual({ status: "expired" });
  });

  it("consumes before awaiting and consumes failed runs", async () => {
    const gate = new ConfirmationGate();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate.propose("chat", "held", async () => {
      await held;
      return "done";
    });
    const nonce = gate.peek("chat")!.nonce;
    const first = gate.confirm("chat", nonce);
    expect(await gate.confirm("chat", nonce)).toEqual({ status: "none" });
    release();
    await expect(first).resolves.toMatchObject({ status: "executed", result: "done" });

    gate.propose("chat", "fails", async () => {
      throw new Error("server refused");
    });
    const failedNonce = gate.peek("chat")!.nonce;
    expect(await gate.confirm("chat", failedNonce)).toEqual({
      status: "failed",
      summary: "fails",
      message: "server refused",
    });
    expect(await gate.confirm("chat", failedNonce)).toEqual({ status: "none" });
  });

  it("cancels only the matching proposal", () => {
    const gate = new ConfirmationGate();
    expect(gate.cancel("chat", "x")).toBe("none");
    gate.propose("chat", "summary", async () => true);
    const nonce = gate.peek("chat")!.nonce;
    expect(gate.cancel("chat", "wrong")).toBe("mismatch");
    expect(gate.peek("chat")).toBeDefined();
    expect(gate.cancel("chat", nonce)).toBe("canceled");
    expect(gate.cancel("chat", nonce)).toBe("none");
  });
});

describe("gateMutatingTool", () => {
  it("passes non-gated tools through by reference", () => {
    const inner = fakeTool(async () => true);
    expect(
      gateMutatingTool("memory_write", inner, new ConfirmationGate(), undefined, () => "chat"),
    ).toBe(inner);
  });

  it("proposes without executing and returns only the model-safe shape", async () => {
    const execute = vi.fn(async () => ({ saved: true }));
    const gate = new ConfirmationGate();
    const wrapped = gateMutatingTool(
      "plan_save",
      fakeTool(execute),
      gate,
      async () => ({ summary: "Save plan" }),
      () => "chat",
    );
    const result = (await wrapped.execute!({}, {} as never)) as Record<string, unknown>;
    expect(result).toEqual({ pendingConfirmation: true, summary: "Save plan" });
    expect(Object.keys(result)).toEqual(["pendingConfirmation", "summary"]);
    expect(execute).not.toHaveBeenCalled();
    const proposal = gate.peek("chat")!;
    expect(await gate.confirm("chat", proposal.nonce)).toMatchObject({ status: "executed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed without chat context and passes blocks through verbatim", async () => {
    const execute = vi.fn();
    const gate = new ConfirmationGate();
    const unavailable = gateMutatingTool(
      "plan_save",
      fakeTool(execute),
      gate,
      async () => ({ summary: "Save" }),
      () => undefined,
    );
    expect(await unavailable.execute!({}, {} as never)).toEqual({
      error: "confirmation_unavailable",
    });

    const missingSummarizer = gateMutatingTool(
      "plan_save",
      fakeTool(execute),
      gate,
      undefined,
      () => "chat",
    );
    expect(await missingSummarizer.execute!({}, {} as never)).toEqual({
      error: "confirmation_unavailable",
    });

    const block = { error: "past_workout_protected", details: "past" };
    const blocked = gateMutatingTool(
      "intervals_delete_workout",
      fakeTool(execute),
      gate,
      async () => ({ block }),
      () => "chat",
    );
    expect(await blocked.execute!({}, {} as never)).toBe(block);
    expect(gate.peek("chat")).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("proposal summarizers and guard reuse", () => {
  it("uses create input truth, falls back safely, and summarizes plans", async () => {
    const { client } = fakeIntervals();
    const summarizers = createProposalSummarizers({ intervals: client, tz: "UTC" });
    await expect(
      summarizers.intervals_create_workout!({
        date: "2030-04-05",
        workout: { name: "Tempo build" },
      }),
    ).resolves.toEqual({ summary: 'Create workout "Tempo build" on 2030-04-05' });
    await expect(summarizers.intervals_create_workout!({})).resolves.toEqual({
      summary: "Create a workout",
    });
    await expect(
      summarizers.intervals_create_strength_workout!({
        date: "2030-04-06",
        name: "Lower body 45min",
      }),
    ).resolves.toEqual({
      summary: 'Create strength workout "Lower body 45min" on 2030-04-06',
    });
    await expect(
      summarizers.intervals_create_strength_workout!({}),
    ).resolves.toEqual({
      summary: "Create a strength workout",
    });
    await expect(summarizers.plan_save!({ plan: {} })).resolves.toEqual({
      summary: "Save the training plan — replaces the current saved plan",
    });
    await expect(summarizers.plan_save!({ plan: { name: "Base block" } })).resolves.toEqual({
      summary: "Save the training plan — replaces the current saved plan — Base block",
    });
  });

  it("host-fetches delete truth and mirrors all refusals in guard order", async () => {
    const fake = fakeIntervals();
    const summarize = createProposalSummarizers({
      intervals: fake.client,
      tz: "UTC",
    }).intervals_delete_workout!;
    await expect(summarize({ eventId: 42, narrative: "delete something else" })).resolves.toEqual({
      summary: 'Delete workout "Fetched truth" on 2999-01-02',
    });

    fake.setEvent(event({ category: "RACE_A", startDateLocal: "2000-01-01T00:00:00" }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "not_a_workout" },
    });
    fake.setEvent(event({ category: "NOTE", startDateLocal: "2000-01-01T00:00:00" }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "not_a_workout" },
    });
    fake.setEvent(event({ tags: [] }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "not_coach_created" },
    });
    fake.setEvent(event({ startDateLocal: "2000-01-01T00:00:00" }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "past_workout_protected" },
    });
  });

  it("passes fetch failures through as typed blocks", async () => {
    const client = {
      events: {
        get: vi.fn(async () => ({
          ok: false,
          error: { kind: "NotFound", status: 404, message: "missing" },
        })),
      },
    } as unknown as IntervalsClient;
    const summarize = createProposalSummarizers({
      intervals: client,
      tz: "UTC",
    }).intervals_delete_workout!;
    await expect(summarize({ eventId: 1 })).resolves.toEqual({
      block: { error: "NotFound", status: 404, message: "missing" },
    });
  });

  it("re-fetches and re-guards when a confirmed delete runs", async () => {
    const fake = fakeIntervals();
    const raw = createPureCoreIntervalsTools(fake.client, "UTC").intervals_delete_workout!;
    const gate = new ConfirmationGate();
    const wrapped = gateMutatingTool(
      "intervals_delete_workout",
      raw,
      gate,
      createProposalSummarizers({ intervals: fake.client, tz: "UTC" }).intervals_delete_workout,
      () => "chat",
    );
    await wrapped.execute!({ eventId: 42 }, {} as never);
    const proposal = gate.peek("chat")!;
    fake.setEvent(event({ category: "NOTE" }));
    const outcome = await gate.confirm("chat", proposal.nonce);
    expect(outcome).toMatchObject({
      status: "executed",
      result: { error: "not_a_workout" },
    });
    expect(fake.gets).toHaveBeenCalledTimes(2);
    expect(fake.deletes).not.toHaveBeenCalled();
  });

  it("keeps gate and read allowlists exact and disjoint", () => {
    expect([...GATED_TOOL_NAMES].sort()).toEqual([
      "intervals_create_strength_workout",
      "intervals_create_workout",
      "intervals_delete_workout",
      "plan_save",
    ]);
    expect([...READ_ONLY_TOOL_NAMES].filter((name) => GATED_TOOL_NAMES.has(name))).toEqual([]);
  });
});
