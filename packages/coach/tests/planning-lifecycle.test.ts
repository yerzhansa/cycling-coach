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
  it("blocks Draft creation until an FTP source is available", () => {
    const ftp = {
      status: "required" as const,
      manual: null,
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: null,
      usedWatts: null,
      conflict: false,
      error: null,
    };
    const blocked = build({ readyToCreateDraft: true, ftp });
    expect(blocked).toMatchObject({ scenarioId: "PL-S003", projection: "coach" });
    expect(blocked.transitions.map((transition) => transition.transitionId)).not.toContain(
      "PL-T06",
    );
    expect(
      build({
        readyToCreateDraft: true,
        ftp: {
          ...ftp,
          status: "accepted",
          manual: { watts: 282, refreshedAtMs: 1 },
          usedSource: "manual",
          usedWatts: 282,
        },
      }),
    ).toMatchObject({ scenarioId: "PL-S016" });
  });

  it("projects FTP refresh, conflict, failure, and accepted return states", () => {
    const ftp = {
      status: "accepted" as const,
      manual: { watts: 282, refreshedAtMs: 1 },
      intervalsFtp: { watts: 282, refreshedAtMs: 2 },
      intervalsEftp: null,
      usedSource: "manual" as const,
      usedWatts: 282,
      conflict: false,
      error: null,
    };
    expect(build({ ftp, ftpScenario: "PL-S057" })).toMatchObject({
      scenarioId: "PL-S057",
      title: "Refreshing Intervals",
    });
    expect(
      build({
        ftp: {
          ...ftp,
          status: "conflict",
          intervalsFtp: { watts: 278, refreshedAtMs: 2 },
          conflict: true,
        },
        ftpScenario: "PL-S060",
      }),
    ).toMatchObject({ scenarioId: "PL-S060", title: "FTP source selected" });
    expect(build({ ftp, ftpScenario: "PL-S062" })).toMatchObject({
      scenarioId: "PL-S062",
      title: "FTP accepted",
    });
  });

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

  it("projects every Race Course recovery state without hiding a ready Draft", () => {
    const summary = {
      fileName: "almaty-gran-fondo.gpx",
      format: "gpx" as const,
      pointCount: 42,
      distanceM: 120_000,
      elevationGainM: 1_500,
      elevationStatus: "available" as const,
    };
    const draft = {
      id: "draft-1",
      planId: "plan-1",
      revision: 1,
      status: "ready" as const,
      snapshot: {},
    };
    expect(
      build({
        draft,
        courseScenario: "PL-S069",
        course: {
          status: "recalculation-failed",
          accepted: summary,
          candidate: { ...summary, fileName: "replacement.gpx" },
          fileName: null,
          detail: "Draft recalculation failed.",
        },
      }),
    ).toMatchObject({
      scenarioId: "PL-S069",
      lifecycle: "draft",
      projection: "draft",
      revision: 1,
      data: { course: { status: "recalculation-failed" } },
    });
    expect(
      build({
        courseScenario: "PL-S104",
        course: {
          status: "omission-failed",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: "Nothing changed.",
        },
      }),
    ).toMatchObject({
      scenarioId: "PL-S104",
      lifecycle: "intake",
      projection: "coach",
    });
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
