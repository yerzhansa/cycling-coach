import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { CoachEngine as ContractCoachEngine } from "@enduragent/coach-contract";
import type { CoachEngine, CreateCoachEngineInput, EngineHostPorts } from "@enduragent/engine";
import type { Sport } from "@enduragent/engine/sport";

// @ts-expect-error The export map must deny every engine-internal deep import.
import type { EngineHostPorts as ForbiddenDeepImport } from "@enduragent/engine/host-ports";

const deepImportMustStayUnresolvable = null as unknown as ForbiddenDeepImport;
void deepImportMustStayUnresolvable;

describe("engine scaffold", () => {
  it("pins the only two public package entry points", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: unknown };
    expect(manifest.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./sport": {
        types: "./dist/sport.d.ts",
        import: "./dist/sport.js",
      },
    });
  });

  it("exports only the canonical factory and authorized account-id helper at runtime", async () => {
    expect(Object.keys(await import("@enduragent/engine")).sort()).toEqual([
      "API_KEY_BILLING_IDENTITY_LINE",
      "ATHLETE_CONTEXT_FENCE_CLOSE",
      "ATHLETE_CONTEXT_FENCE_OPEN",
      "ATHLETE_CONTEXT_TRUNCATION_NOTICE",
      "CLAUDE_CLI_PRICE_TABLE",
      "CODEX_AGENT_PRICE_TABLE",
      "COMPACTION_SUMMARY_MARKER",
      "ClaudeCliConfigError",
      "ClaudeWorkingAreaError",
      "CodexAgentConfigError",
      "DATE_KEY_RE",
      "EMPTY_PROVENANCE",
      "FENCE_TOKEN_REPLACEMENT",
      "GARMIN_DATA_ATTRIBUTION",
      "INTERVALS_LIST_MAX_RANGE_DAYS",
      "PLAN_MIRROR_DAYS",
      "PLAN_MIRROR_EXTERNAL_ID_PREFIX",
      "RaceCourseLifecycleError",
      "SUMMARY_PREFIX",
      "TOOL_RESULT_SHARE",
      "UNKNOWN_PROVENANCE",
      "_resetOrphanWarnCacheForTesting",
      "acceptParsedRaceCourse",
      "beginRaceCourseParsing",
      "beginRaceCourseRemoval",
      "bindToolResult",
      "boundToolResultProvenance",
      "cacheReadSavingsUsd",
      "capToolResult",
      "carryBoundToolResultProvenance",
      "classifyActivities",
      "classifyActivity",
      "classifySpendCaching",
      "classifyTrustedSource",
      "claudeCliCacheReadSavingsUsd",
      "claudeIdentityLine",
      "cleanupPlanMirror",
      "codexAgentCacheReadSavingsUsd",
      "codexIdentityLine",
      "completeRaceCourseRecalculation",
      "contentDigest",
      "createClaudeWorkingArea",
      "createCoachEngine",
      "dateKeySchema",
      "demoteSummaryHeadings",
      "ensureClaudeCliReady",
      "ensureCodexAgentReady",
      "executePlanFtpTransition",
      "extractAccountId",
      "failRaceCourseRecalculation",
      "formatCompactionNote",
      "getMessageProvenance",
      "invalidateClaudeAccountProbeCache",
      "invalidateCodexAgentProbeCache",
      "isNonEmptyData",
      "isProviderAuthFailure",
      "isSourceProvenance",
      "isUntrustedEnvelope",
      "makeSummaryMessage",
      "markProviderAuthFailure",
      "markUntrustedResult",
      "openRaceCoursePicker",
      "persistCompactionSummary",
      "planMirrorExternalId",
      "planMirrorExternalIdPrefix",
      "priceClaudeCliInclusiveUsage",
      "priceCodexAgentInclusiveUsage",
      "priceInclusiveUsage",
      "probeClaudeAccountCached",
      "projectPlanReconciliation",
      "provenanceForSourceBearingData",
      "provenanceOfMessages",
      "recheckClaudeAccount",
      "reconcileActivePlanWindow",
      "rejectRaceCourseFile",
      "renderGarminAttribution",
      "resolveClaudeCliPriceId",
      "resolveCodexAgentPriceId",
      "retryRaceCourseRecalculation",
      "sanitizeUntrustedText",
      "setMessageProvenance",
      "splitHistoryByBudget",
      "truncateUtf16Safe",
      "unionProvenance",
      "unwrapBoundToolResult",
      "useRouteWithoutElevation",
      "validateListRange",
      "validateWorkoutCreationDate",
      "warnOrphanSections",
      "wrapAthleteContextFence",
    ]);
  });

  it("reuses the contract and pins the injected factory input", () => {
    expectTypeOf<CoachEngine>().toEqualTypeOf<ContractCoachEngine>();
    expectTypeOf<CreateCoachEngineInput>().toEqualTypeOf<{
      readonly sport: Sport;
      readonly ports: EngineHostPorts;
    }>();
  });
});
