export type PlanFtpSource = "manual" | "intervals-ftp" | "intervals-eftp";

export interface PlanFtpSourceValue {
  readonly watts: number;
  readonly refreshedAtMs: number;
}

export interface PlanFtpSnapshot {
  readonly manual: PlanFtpSourceValue | null;
  readonly intervalsFtp: PlanFtpSourceValue | null;
  readonly intervalsEftp: PlanFtpSourceValue | null;
  readonly usedSource: PlanFtpSource | null;
  readonly usedWatts: number | null;
  readonly conflict: boolean;
}

export interface PlanFtpAdapter {
  read(): Promise<PlanFtpSnapshot>;
  saveManual(watts: number): Promise<PlanFtpSnapshot>;
  refreshIntervals(): Promise<PlanFtpSnapshot>;
}

export interface PlanFtpTransitionInput {
  readonly source: "manual" | "intervals" | "intervals-ftp" | "intervals-eftp";
  readonly watts: number | null;
}

export async function executePlanFtpTransition(
  adapter: PlanFtpAdapter,
  input: PlanFtpTransitionInput,
): Promise<PlanFtpSnapshot> {
  if (input.source === "manual") {
    if (input.watts === null) throw new TypeError("Manual FTP requires watts.");
    return adapter.saveManual(input.watts);
  }
  if (input.watts !== null) throw new TypeError("Intervals refresh forbids manual watts.");
  return adapter.refreshIntervals();
}
