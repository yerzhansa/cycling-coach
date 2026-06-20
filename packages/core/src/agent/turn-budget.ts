export const MAX_TURN_MODEL_CALLS = 40;
export const MAX_TURN_GENERATE_ATTEMPTS = 4;
export const TURN_WALL_CLOCK_MS = 5 * 60_000;

export type BudgetExceededKind = "model_calls" | "generate_attempts" | "wall_clock";

export class TurnBudgetExceededError extends Error {
  readonly kind: BudgetExceededKind;
  constructor(kind: BudgetExceededKind, detail: string) {
    super(detail);
    this.name = "TurnBudgetExceededError";
    this.kind = kind;
  }
}

export interface TurnBudget {
  /** Throws TurnBudgetExceededError("model_calls") if a model call would exceed the cap. Call BEFORE every llm.generate. */
  chargeModelCall(): void;
  /** Charge one outer generate attempt. Throws "generate_attempts" past the attempt cap. */
  chargeAttempt(): void;
  /** Between-attempt deadline check (never mid-attempt). Throws "wall_clock" on overrun. */
  checkDeadline(): void;
}

export function createTurnBudget(now: () => number): TurnBudget {
  const turnStart = now();
  let modelCalls = 0;
  let attempts = 0;
  return {
    chargeModelCall() {
      modelCalls++;
      if (modelCalls > MAX_TURN_MODEL_CALLS) {
        throw new TurnBudgetExceededError(
          "model_calls",
          `Per-turn model-call budget exceeded (${MAX_TURN_MODEL_CALLS}).`,
        );
      }
    },
    chargeAttempt() {
      attempts++;
      if (attempts > MAX_TURN_GENERATE_ATTEMPTS) {
        throw new TurnBudgetExceededError(
          "generate_attempts",
          `Per-turn generate-attempt budget exceeded (${MAX_TURN_GENERATE_ATTEMPTS}).`,
        );
      }
    },
    checkDeadline() {
      if (now() - turnStart >= TURN_WALL_CLOCK_MS) {
        throw new TurnBudgetExceededError(
          "wall_clock",
          `Per-turn wall-clock deadline exceeded (${TURN_WALL_CLOCK_MS}ms).`,
        );
      }
    },
  };
}
