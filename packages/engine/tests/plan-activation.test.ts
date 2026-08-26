import { describe, expect, it, vi } from "vitest";
import type { PlanConversationRepository } from "@enduragent/kernel/planning";
import { activatePlanDraft } from "../src/index.js";

describe("Plan Draft activation command", () => {
  it("forwards revision and authored identity to the atomic repository boundary", async () => {
    const approveDraft = vi.fn(async () => ({
      planId: "00000000000000000000000001",
      draft: { status: "approved" },
    }));
    const result = await activatePlanDraft(
      { draftRevisionId: "00000000000000000000000002", expectedRevision: 4 },
      {
        drafts: { approveDraft } as unknown as PlanConversationRepository,
        identity: {
          deviceId: async () => "device-1",
          hlcStamp: () => ({ physicalMs: 42, counter: 3 }),
        },
      },
    );

    expect(approveDraft).toHaveBeenCalledWith({
      draftRevisionId: "00000000000000000000000002",
      expectedRevision: 4,
      updatedAtMs: 42,
      deviceId: "device-1",
      hlcPhysicalMs: 42,
      hlcCounter: 3,
    });
    expect(result).toMatchObject({ planId: "00000000000000000000000001" });
  });
});
