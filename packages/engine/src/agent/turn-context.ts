import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import { EMPTY_PROVENANCE, type SourceProvenance } from "../provenance.js";
import type { CoachDecisionReadModel } from "@enduragent/coach-contract";
import type { PlanIntakePatch } from "@enduragent/coach-contract";

export interface TurnWriteRecord {
  writesCommitted: number;
  lastWriteSummary?: string;
}

export interface TurnProvenanceRecord {
  value: SourceProvenance;
}

export interface TurnDecisionRecord {
  requested: CoachDecisionReadModel | null;
  fallbackText: string | null;
}

export interface TurnPlanIntakeRecord {
  patch: PlanIntakePatch | null;
}

// Explicit per-turn state, threaded to tool execution through the
// tool-execution options instead of an ambient per-process store: chat()
// creates one TurnContext per turn and attaches it to the generate call; the
// model SDK delivers it to each tool execute's options, and the codex bridge
// mirrors the same key. Concurrent turns — different chats, or rapid same-chat
// sends whose synchronous prologues interleave before each turn's lock body
// resumes — each carry their OWN object, so no turn can read or clobber
// another's anchor, read cache, or write record, while the tool set (built
// once at construction) and the cached template hash never rebuild.
export interface TurnContext {
  /** Resolved primary anchor (running critical speed) for this turn; null when the channel supplies none. */
  readonly resolvedCs: ResolvedCs | null;
  /** Chat this turn belongs to; the key a host confirmation surface resolves a proposal against. */
  readonly chatId: string;
  readonly turnId: string;
  readonly athleteText: string;
  /** Per-turn read-tool memoizer cache. */
  readonly readToolCache: Map<string, unknown>;
  /** Committed-write record; a committed write makes the turn non-replayable. */
  readonly turnWrites: TurnWriteRecord;
  /** Running union of the source labels this turn's reply may rest on. */
  readonly provenance: TurnProvenanceRecord;
  /** Source labels of the reference snapshot the channel resolved this turn's anchor from. */
  readonly referenceProvenance: SourceProvenance;
  readonly decision: TurnDecisionRecord;
  readonly planIntake: TurnPlanIntakeRecord;
}

const TURN_CONTEXT_BRAND = Symbol("turn-context");

interface BrandedTurnContext extends TurnContext {
  readonly [TURN_CONTEXT_BRAND]: true;
}

export function createTurnContext(
  resolvedCs: ResolvedCs | null,
  chatId: string = "",
  referenceProvenance: SourceProvenance = EMPTY_PROVENANCE,
  athleteText: string = "",
  turnId: string = "",
): TurnContext {
  const ctx: BrandedTurnContext = {
    [TURN_CONTEXT_BRAND]: true,
    resolvedCs,
    chatId,
    turnId,
    athleteText,
    readToolCache: new Map<string, unknown>(),
    turnWrites: { writesCommitted: 0 },
    provenance: { value: EMPTY_PROVENANCE },
    referenceProvenance,
    decision: { requested: null, fallbackText: null },
    planIntake: { patch: null },
  };
  return ctx;
}

// Tool-execution options are `unknown` at the wrapper seams. A tool executing
// with no turn in scope (e.g. the memory flush during an explicit session
// reset) resolves to undefined, and every consumer fails open: reads run
// unmemoized, writes go unrecorded, the anchor reads null.
export function getTurnContext(options: unknown): TurnContext | undefined {
  if (options === null || typeof options !== "object") return undefined;
  const candidate = (options as { experimental_context?: unknown }).experimental_context;
  if (candidate === null || typeof candidate !== "object") return undefined;
  return (candidate as Partial<BrandedTurnContext>)[TURN_CONTEXT_BRAND] === true
    ? (candidate as TurnContext)
    : undefined;
}
