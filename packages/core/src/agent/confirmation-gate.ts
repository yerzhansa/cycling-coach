import { randomUUID } from "node:crypto";
import type { Tool } from "ai";
import type { IntervalsClient } from "../intervals.js";
import {
  guardDeletableEvent,
  toTypedError,
  type IntervalsEventRuntime,
} from "./intervals-tools.js";

export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "intervals_create_workout",
  "intervals_delete_workout",
  "plan_save",
]);

export const PROPOSAL_TTL_MS = 10 * 60_000;

export interface PendingProposal {
  nonce: string;
  summary: string;
  expiresAt: number;
  run: () => Promise<unknown>;
}

export type ConfirmOutcome =
  | { status: "executed"; summary: string; result: unknown }
  | { status: "failed"; summary: string; message: string }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "none" };

export function formatConfirmOutcome(outcome: ConfirmOutcome): string {
  if (outcome.status === "executed") return `Done — ${outcome.summary}.`;
  if (outcome.status === "failed") return `That didn't go through — ${outcome.message}`;
  return "That proposal expired — ask me again and I'll re-propose.";
}

export class ConfirmationGate {
  private readonly proposals = new Map<string, PendingProposal>();

  constructor(private readonly now: () => number = Date.now) {}

  propose(chatId: string, summary: string, run: () => Promise<unknown>): void {
    this.proposals.set(chatId, {
      nonce: randomUUID(),
      summary,
      expiresAt: this.now() + PROPOSAL_TTL_MS,
      run,
    });
  }

  private lookup(chatId: string): {
    proposal: PendingProposal | undefined;
    expired: boolean;
  } {
    const proposal = this.proposals.get(chatId);
    if (proposal === undefined) return { proposal: undefined, expired: false };
    if (proposal.expiresAt <= this.now()) {
      this.proposals.delete(chatId);
      return { proposal: undefined, expired: true };
    }
    return { proposal, expired: false };
  }

  peek(chatId: string): { nonce: string; summary: string } | undefined {
    const { proposal } = this.lookup(chatId);
    if (proposal === undefined) return undefined;
    return { nonce: proposal.nonce, summary: proposal.summary };
  }

  async confirm(chatId: string, nonce: string): Promise<ConfirmOutcome> {
    const { proposal, expired } = this.lookup(chatId);
    if (proposal === undefined) return { status: expired ? "expired" : "none" };
    if (proposal.nonce !== nonce) return { status: "mismatch" };
    this.proposals.delete(chatId);
    try {
      return { status: "executed", summary: proposal.summary, result: await proposal.run() };
    } catch (err) {
      return {
        status: "failed",
        summary: proposal.summary,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  cancel(chatId: string, nonce: string): "canceled" | "mismatch" | "none" {
    const { proposal } = this.lookup(chatId);
    if (proposal === undefined) return "none";
    if (proposal.nonce !== nonce) return "mismatch";
    this.proposals.delete(chatId);
    return "canceled";
  }
}

export type Summarized = { summary: string } | { block: unknown };
export type ProposalSummarizer = (input: unknown) => Promise<Summarized>;

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

export function createProposalSummarizers(opts: {
  intervals: IntervalsClient | null;
  tz: string;
}): Record<string, ProposalSummarizer> {
  return {
    intervals_create_workout: async (input) => {
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const date = stringField(input, "date");
      const workout = objectField(input, "workout");
      const name = stringField(workout, "name");
      return date !== undefined && name !== undefined
        ? { summary: `Create workout "${name}" on ${date}` }
        : { summary: "Create a workout" };
    },
    intervals_delete_workout: async (input) => {
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const eventId = objectField(input, "eventId");
      if (typeof eventId !== "number") return { block: { error: "invalid_event_id" } };
      const fetched = await opts.intervals.events.get(eventId);
      if (!fetched.ok) return { block: toTypedError(fetched.error) };
      const event = fetched.value as unknown as IntervalsEventRuntime;
      const refusal = guardDeletableEvent(event, opts.tz, eventId);
      if (refusal !== undefined) return { block: refusal };
      const date = event.startDateLocal.slice(0, 10);
      return { summary: `Delete workout "${event.name ?? "Unnamed workout"}" on ${date}` };
    },
    plan_save: async (input) => {
      const plan = objectField(input, "plan");
      const detail = stringField(plan, "name") ?? stringField(plan, "goal");
      return {
        summary:
          "Save the training plan — replaces the current saved plan" +
          (detail === undefined ? "" : ` — ${detail}`),
      };
    },
  };
}

export function gateMutatingTool(
  name: string,
  tool: Tool,
  gate: ConfirmationGate,
  summarize: ProposalSummarizer | undefined,
  chatId: () => string | undefined,
): Tool {
  if (!GATED_TOOL_NAMES.has(name)) return tool;
  const inner = tool.execute;
  if (typeof inner !== "function") return tool;
  return {
    ...tool,
    execute: async (input: unknown) => {
      const id = chatId();
      if (id === undefined) return { error: "confirmation_unavailable" };
      if (summarize === undefined) return { error: "confirmation_unavailable" };
      const summarized = await summarize(input);
      if ("block" in summarized) return summarized.block;
      const { summary } = summarized;
      gate.propose(id, summary, () =>
        (inner as (input: unknown, options: never) => Promise<unknown>)(input, {} as never),
      );
      return { pendingConfirmation: true, summary };
    },
  } as Tool;
}
