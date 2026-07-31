export interface ToolExecutionOutcome {
  toolName: string;
  recordedResult: unknown;
  liveResult: unknown;
  liveExecuted: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function unwrapUntrustedEnvelope(value: unknown): unknown {
  const record = asRecord(value);
  if (record === null) return value;
  if (typeof record.untrusted_data === "string" && "data" in record) return record.data;
  return value;
}

export function isProposalResult(value: unknown): boolean {
  const payload = asRecord(unwrapUntrustedEnvelope(value));
  return payload !== null && payload.pendingConfirmation === true;
}

export function capturedWrite(outcome: ToolExecutionOutcome): boolean {
  if (!outcome.liveExecuted) return false;
  if (isProposalResult(outcome.recordedResult)) return false;
  if (isProposalResult(outcome.liveResult)) return false;
  return true;
}

export function countCapturedWrites(
  outcomes: readonly ToolExecutionOutcome[],
  toolName: string,
): number {
  return outcomes.filter((o) => o.toolName === toolName && capturedWrite(o)).length;
}
