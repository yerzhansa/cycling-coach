import { describe, expect, it } from "vitest";
import { buildPlanLifecycleReadModel } from "../src/planning-lifecycle.js";

const queue = { schemaVersion: 1 as const, revision: 0, items: [] };
const conversation = {
  id: "conversation-1",
  planId: null,
  replacesPlanId: null,
  sourceConversationId: null,
};

function build(input: Partial<Parameters<typeof buildPlanLifecycleReadModel>[0]> = {}) {
  return buildPlanLifecycleReadModel({
    conversation,
    turns: [],
    readyToCreateDraft: false,
    queue,
    decision: null,
    draft: null,
    ...input,
  });
}

describe("Plan lifecycle projection", () => {
  it("keeps the dedicated conversation available from intake through readiness", () => {
    expect(build()).toMatchObject({
      scenarioId: "PL-S017",
      lifecycle: "intake",
      projection: "coach",
    });
    const ready = build({ readyToCreateDraft: true });
    expect(ready).toMatchObject({
      scenarioId: "PL-S016",
      lifecycle: "intake",
      projection: "coach",
    });
    expect(ready.transitions.map((transition) => transition.transitionId)).toContain("PL-T06");
  });

  it("projects forming, revised, and discarded Draft states without losing the conversation", () => {
    expect(
      build({
        draft: { id: "draft-1", planId: "plan-1", revision: 1, status: "forming", snapshot: {} },
      }),
    ).toMatchObject({ scenarioId: "PL-S018", lifecycle: "draft-forming", projection: "draft" });
    expect(
      build({
        draft: { id: "draft-1", planId: "plan-1", revision: 2, status: "ready", snapshot: {} },
      }),
    ).toMatchObject({ scenarioId: "PL-S031", lifecycle: "draft", title: "Draft updated" });
    const discarded = build({
      draft: { id: "draft-1", planId: "plan-1", revision: 2, status: "discarded", snapshot: {} },
    });
    expect(discarded).toMatchObject({
      scenarioId: "PL-S020",
      lifecycle: "intake",
      projection: "coach",
    });
    expect(discarded.data).toMatchObject({ conversationId: "conversation-1" });
  });

  it("keeps the active Plan while a replacement Draft is discussed and formed", () => {
    const replacement = { ...conversation, planId: "plan-1", replacesPlanId: "plan-1" };
    expect(build({ conversation: replacement })).toMatchObject({
      scenarioId: "PL-S079",
      lifecycle: "replacement-intake",
    });
    expect(
      build({
        conversation: replacement,
        draft: { id: "draft-2", planId: "plan-2", revision: 1, status: "forming", snapshot: {} },
      }),
    ).toMatchObject({ scenarioId: "PL-S105", lifecycle: "replacement-draft-forming" });
  });
});
