import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as engine from "../src/index.js";
import type { ChatStreamTimeouts } from "../src/index.js";

const timeoutTypeProof: ChatStreamTimeouts = { ttftMs: 1, interChunkMs: 1 };

describe("engine public export surface", () => {
  it("keeps only the root and sport package subpaths", () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./sport"]);
  });

  it("exports only the canonical factory and the authorized JWT account helper at runtime", () => {
    expect(Object.keys(engine).sort()).toEqual([
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
      "PlanProposalError",
      "PlanStartDateError",
      "PlanUndoError",
      "PlanWorkoutDriftError",
      "RaceCourseLifecycleError",
      "SUMMARY_PREFIX",
      "TOOL_RESULT_SHARE",
      "UNKNOWN_PROVENANCE",
      "WORKOUT_MATCH_AS_PLANNED_MAX_SECONDS",
      "WORKOUT_MATCH_AS_PLANNED_MIN_SECONDS",
      "WORKOUT_MATCH_AS_PLANNED_RATIO",
      "WORKOUT_MATCH_DURATION_MAX_SECONDS",
      "WORKOUT_MATCH_DURATION_MIN_SECONDS",
      "WORKOUT_MATCH_DURATION_RATIO",
      "_resetOrphanWarnCacheForTesting",
      "acceptParsedRaceCourse",
      "activatePlanDraft",
      "adoptProviderWorkoutEdit",
      "applyPlanStartDatePreview",
      "applyValidatedPlanProposal",
      "applyValidatedPlanUndo",
      "beginRaceCourseParsing",
      "beginRaceCourseRemoval",
      "bindToolResult",
      "boundToolResultProvenance",
      "cacheReadSavingsUsd",
      "capToolResult",
      "capturePlanProposalBase",
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
      "encodePlanProposalBase",
      "encodePlanProposalMutation",
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
      "isRacePlanWorkout",
      "isSourceProvenance",
      "isUntrustedEnvelope",
      "makeSummaryMessage",
      "markProviderAuthFailure",
      "markUntrustedResult",
      "openRaceCoursePicker",
      "parsePlanProposalMutation",
      "persistCompactionSummary",
      "planMirrorExternalId",
      "planMirrorExternalIdPrefix",
      "planWorkoutDriftSnapshot",
      "previewPlanStartDate",
      "priceClaudeCliInclusiveUsage",
      "priceCodexAgentInclusiveUsage",
      "priceInclusiveUsage",
      "probeClaudeAccountCached",
      "projectPlanHistoryEligibility",
      "projectPlanProposalDiff",
      "projectPlanReconciliation",
      "projectWorkoutMatches",
      "provenanceForSourceBearingData",
      "provenanceOfMessages",
      "providerWorkoutDriftSnapshot",
      "recheckClaudeAccount",
      "reconcileActivePlanWindow",
      "refreshPlanWorkoutDrifts",
      "refreshPlanWorkoutMatches",
      "rejectRaceCourseFile",
      "renderGarminAttribution",
      "resolveClaudeCliPriceId",
      "resolveCodexAgentPriceId",
      "restorePlanWorkout",
      "retryRaceCourseRecalculation",
      "revalidatePlanProposalPremises",
      "sanitizeUntrustedText",
      "setMessageProvenance",
      "splitHistoryByBudget",
      "truncateUtf16Safe",
      "unionProvenance",
      "unwrapBoundToolResult",
      "useRouteWithoutElevation",
      "validateListRange",
      "validatePlanProposal",
      "validatePlanUndo",
      "validateWorkoutCreationDate",
      "verifyPlanMirror",
      "warnOrphanSections",
      "wrapAthleteContextFence",
    ]);
    expect(timeoutTypeProof).toEqual({ ttftMs: 1, interChunkMs: 1 });
    expect("DEFAULT_CHAT_STREAM_TIMEOUTS" in engine).toBe(false);
  });

  it("retains the Core test helper only as a pure re-export", () => {
    const shimPath = fileURLToPath(
      new URL("../../core/tests/helpers/base-agent-config.ts", import.meta.url),
    );
    const source = readFileSync(shimPath, "utf-8");
    expect(source.trim()).toBe(
      'export * from "../../../engine/tests/helpers/base-agent-config.js";',
    );
    expect(source).not.toMatch(/\b(?:function|class|const|let|var)\b/);
  });
});
