export type PlanningRequestStoreErrorCode =
  | "invalid-create"
  | "invalid-provenance"
  | "invalid-terminal-result"
  | "request-conflict"
  | "missing-request"
  | "invalid-transition"
  | "stale-revision"
  | "immutable-terminal"
  | "corrupt-record";

export class PlanningRequestStoreError extends Error {
  readonly code: PlanningRequestStoreErrorCode;

  constructor(code: PlanningRequestStoreErrorCode) {
    super(`planning request rejected: ${code}`);
    this.name = "PlanningRequestStoreError";
    this.code = code;
  }
}
