import { describe, expect, it, vi } from "vitest";
import {
  executePlanFtpTransition,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
} from "../src/planning/ftp.js";

const snapshot: PlanFtpSnapshot = {
  manual: null,
  intervalsFtp: { watts: 282, refreshedAtMs: 1_000 },
  intervalsEftp: { watts: 289, refreshedAtMs: 1_000 },
  usedSource: "intervals-ftp",
  usedWatts: 282,
  conflict: true,
};

function adapter(): {
  readonly value: PlanFtpAdapter;
  readonly saveManual: ReturnType<typeof vi.fn<PlanFtpAdapter["saveManual"]>>;
  readonly refreshIntervals: ReturnType<typeof vi.fn<PlanFtpAdapter["refreshIntervals"]>>;
} {
  const saveManual = vi.fn<PlanFtpAdapter["saveManual"]>(async () => snapshot);
  const refreshIntervals = vi.fn<PlanFtpAdapter["refreshIntervals"]>(async () => snapshot);
  return {
    value: { read: async () => snapshot, saveManual, refreshIntervals },
    saveManual,
    refreshIntervals,
  };
}

describe("Plan FTP transition", () => {
  it("saves a manual source without refreshing Intervals", async () => {
    const selected = adapter();
    await expect(
      executePlanFtpTransition(selected.value, { source: "manual", watts: 282 }),
    ).resolves.toEqual(snapshot);
    expect(selected.saveManual).toHaveBeenCalledWith(282);
    expect(selected.refreshIntervals).not.toHaveBeenCalled();
  });

  it.each(["intervals", "intervals-ftp", "intervals-eftp"] as const)(
    "refreshes source %s and lets the adapter choose precedence",
    async (source) => {
      const selected = adapter();
      await expect(
        executePlanFtpTransition(selected.value, { source, watts: null }),
      ).resolves.toEqual(snapshot);
      expect(selected.refreshIntervals).toHaveBeenCalledOnce();
      expect(selected.saveManual).not.toHaveBeenCalled();
    },
  );

  it("rejects mismatched source payloads", async () => {
    const selected = adapter();
    await expect(
      executePlanFtpTransition(selected.value, { source: "manual", watts: null }),
    ).rejects.toThrow("Manual FTP requires watts.");
    await expect(
      executePlanFtpTransition(selected.value, { source: "intervals", watts: 282 }),
    ).rejects.toThrow("Intervals refresh forbids manual watts.");
  });
});
