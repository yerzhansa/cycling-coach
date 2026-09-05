import { randomUUID } from "node:crypto";
import type { ToolConfirmationPort } from "@enduragent/engine";
import type { IntervalsClient } from "../intervals.js";
import {
  guardDeletableEvent,
  guardUpdatableEvent,
  toTypedError,
  type IntervalsEventRuntime,
} from "./event-guards.js";

export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "intervals_create_strength_workout",
  "intervals_create_workout",
  "intervals_delete_workout",
  "intervals_update_workout",
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
  | { status: "refused"; summary: string; message: string; result: unknown }
  | { status: "failed"; summary: string; message: string }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "none" };

export function formatConfirmOutcome(outcome: ConfirmOutcome): string {
  if (outcome.status === "executed") return `Done — ${outcome.summary}.`;
  if (outcome.status === "refused") return `Nothing was changed — ${outcome.message}`;
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
      const result = await proposal.run();
      const error = stringField(result, "error");
      if (error !== undefined) {
        const details = stringField(result, "details");
        if (details !== undefined) {
          return { status: "refused", summary: proposal.summary, message: details, result };
        }
        return {
          status: "failed",
          summary: proposal.summary,
          message: stringField(result, "message") ?? error,
        };
      }
      return { status: "executed", summary: proposal.summary, result };
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
    intervals_create_strength_workout: async (input) => {
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const name = stringField(input, "name");
      const date = stringField(input, "date");
      return name !== undefined && date !== undefined
        ? { summary: `Create strength workout "${name}" on ${date}` }
        : { summary: "Create a strength workout" };
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
    intervals_update_workout: async (input) => {
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const eventId = objectField(input, "eventId");
      if (typeof eventId !== "number") return { block: { error: "invalid_event_id" } };
      const changes = objectField(input, "changes");
      if (changes === null || typeof changes !== "object") {
        return { block: { error: "invalid_changes" } };
      }
      const date = stringField(changes, "date");
      const fetched = await opts.intervals.events.get(eventId);
      if (!fetched.ok) return { block: toTypedError(fetched.error) };
      const event = fetched.value as unknown as IntervalsEventRuntime;
      const refusal = guardUpdatableEvent(event, opts.tz, eventId, date);
      if (refusal !== undefined) return { block: refusal };
      const fields: string[] = [];
      if (date !== undefined) fields.push(`date to ${date}`);
      const name = stringField(changes, "name");
      if (name !== undefined) fields.push(`name to "${name}"`);
      if (objectField(changes, "description") !== undefined) fields.push("description");
      const movingTime = objectField(changes, "movingTime");
      if (typeof movingTime === "number") fields.push(`duration to ${movingTime} seconds`);
      const trainingLoad = objectField(changes, "icuTrainingLoad");
      if (typeof trainingLoad === "number") fields.push(`training load to ${trainingLoad}`);
      if (objectField(changes, "workoutDoc") !== undefined) fields.push("workout structure");
      const eventDate = event.startDateLocal.slice(0, 10);
      const detail = fields.length === 0 ? "selected fields" : fields.join(", ");
      return {
        summary: `Update workout "${event.name ?? "Unnamed workout"}" on ${eventDate} — ${detail}`,
      };
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

export function createToolConfirmationPort(opts: {
  gate: ConfirmationGate;
  summarizers: Record<string, ProposalSummarizer>;
  prepareRun?: (name: string, run: () => Promise<unknown>) => () => Promise<unknown>;
  requiresConfirmation?: (input: { readonly chatId: string; readonly toolName: string }) => boolean;
}): ToolConfirmationPort {
  return {
    gatedToolNames: GATED_TOOL_NAMES,
    requiresConfirmation: opts.requiresConfirmation ?? (() => true),
    propose: async ({ chatId, toolName, toolInput, run }) => {
      const summarize = opts.summarizers[toolName];
      if (summarize === undefined) return { error: "confirmation_unavailable" };
      const summarized = await summarize(toolInput);
      if ("block" in summarized) return summarized.block;
      const { summary } = summarized;
      opts.gate.propose(chatId, summary, opts.prepareRun?.(toolName, run) ?? run);
      return { pendingConfirmation: true, summary };
    },
  };
}
