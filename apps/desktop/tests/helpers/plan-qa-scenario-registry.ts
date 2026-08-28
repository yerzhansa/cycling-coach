import {
  PLAN_TRANSITION_IDS,
  PlanReadModelSchema,
  PlanScenarioIdSchema,
  type ExecutePlanTransitionRpcResult,
  type PlanActiveProjectionData,
  type PlanEndedProjectionData,
  type PlanError,
  type PlanReadModel,
  type PlanScenarioId,
  type PlanTransitionId,
} from "@enduragent/coach-contract";
import {
  buildActivePlanReadModel,
  buildEndedPlanReadModel,
  buildPlanLifecycleReadModel,
  type ActivePlanScenario,
  type EndedPlanScenario,
} from "../../../../packages/coach/src/planning-lifecycle.js";

export type PlanOwnedScenarioId = Exclude<PlanScenarioId, "PL-S099">;
export type PlanQaScenarioClassification = "server" | "interaction" | "in-flight" | "dimension";
export type PlanQaMutationBoundary = "none" | "draft-local" | "plan-local" | "provider-after-local";

export interface PlanQaScenarioDefinition {
  readonly id: PlanOwnedScenarioId;
  readonly name: string;
  readonly classification: PlanQaScenarioClassification;
  readonly source: "planning-read-model" | "renderer-state" | "progress-event" | "display-mode";
  readonly sourceScenarioId: PlanOwnedScenarioId | null;
  readonly entryTransitionId: PlanTransitionId | null;
  readonly entry: string;
  readonly action: string;
  readonly expectedTransitions: readonly PlanTransitionId[];
  readonly expectation: PlanQaScenarioExpectation;
  readonly accessibility: string;
  readonly status: "executable";
  readonly recovery: string;
  readonly mutationBoundary: PlanQaMutationBoundary;
  readonly cold: boolean;
  readonly hold: "submitting" | "running" | "resumed" | null;
  readonly theme: "light" | "dark" | null;
}

export interface PlanQaScenarioExpectation {
  readonly persistedFacts: "none" | "conversation" | "draft" | "active-plan" | "ended-plan";
  readonly transient: "none" | "submitting" | "running" | "resumed";
  readonly visibleHeading: string;
  readonly visibleActions: readonly PlanTransitionId[];
  readonly retryTransitionId: PlanTransitionId | null;
  readonly dismiss: null | {
    readonly kind: "back" | "cancel" | "close";
    readonly transitionId: "PL-T39";
    readonly destinationScenarioId: PlanOwnedScenarioId;
    readonly focusTarget: string;
  };
  readonly localMutation: boolean;
  readonly providerMutation: boolean;
}

const scenarioId = (value: number): PlanOwnedScenarioId => {
  const parsed = PlanScenarioIdSchema.parse(`PL-S${String(value).padStart(3, "0")}`);
  if (parsed === "PL-S099") throw new TypeError("PL-S099 is Chat-owned");
  return parsed;
};

export const PLAN_OWNED_SCENARIO_IDS = Object.freeze(
  Array.from({ length: 105 }, (_, index) => index + 1)
    .filter((value) => value !== 99)
    .map(scenarioId),
);

const SCENARIO_NAMES: Readonly<Record<PlanOwnedScenarioId, string>> = {
  "PL-S001": "No plan yet",
  "PL-S002": "Coach’s draft",
  "PL-S003": "No FTP",
  "PL-S004": "Plan running",
  "PL-S005": "Plan history",
  "PL-S006": "Season",
  "PL-S007": "Provenance drawer",
  "PL-S008": "Proposal applied",
  "PL-S009": "Race week",
  "PL-S010": "Calendar reconciliation",
  "PL-S011": "Dark mode",
  "PL-S012": "Race readiness",
  "PL-S013": "Rest week / sync down",
  "PL-S014": "Plan ended",
  "PL-S015": "Start-date picker",
  "PL-S016": "Coach ready to create Draft",
  "PL-S017": "Plan-native coach interview",
  "PL-S018": "Draft forming",
  "PL-S019": "Discard confirmation",
  "PL-S020": "Draft discarded / conversation kept",
  "PL-S021": "Workout detail drawer",
  "PL-S022": "Proposal edit with coach",
  "PL-S023": "Revised Proposal",
  "PL-S024": "Proposal revalidation",
  "PL-S025": "Proposal base changed",
  "PL-S026": "Undo expired",
  "PL-S027": "Undo applied",
  "PL-S028": "Plan attention list",
  "PL-S029": "Draft revision with coach",
  "PL-S030": "Draft revision forming",
  "PL-S031": "Completed Draft revision",
  "PL-S032": "Workout changed outside Enduragent",
  "PL-S033": "Adopting outside edit",
  "PL-S034": "Outside edit adopted",
  "PL-S035": "Restoring Plan Workout",
  "PL-S036": "Plan Workout restored",
  "PL-S037": "Plan active locally",
  "PL-S038": "Rolling mirror running",
  "PL-S039": "Rolling mirror failed",
  "PL-S040": "Rolling mirror retrying",
  "PL-S041": "Rolling mirror failed again",
  "PL-S042": "Rolling mirror resumed after restart",
  "PL-S043": "Rolling mirror verified",
  "PL-S044": "Start date · short block boundary",
  "PL-S045": "Start date · midweek race",
  "PL-S046": "Start date invalid",
  "PL-S047": "Date recalculating",
  "PL-S048": "Date recalculation failed",
  "PL-S049": "Date recalculation retrying",
  "PL-S050": "Date recalculated",
  "PL-S051": "End Plan confirmation",
  "PL-S052": "Cleanup running",
  "PL-S053": "Cleanup failed",
  "PL-S054": "Cleanup verifying",
  "PL-S055": "Cleanup retrying",
  "PL-S056": "Cleanup verified",
  "PL-S057": "FTP refresh busy",
  "PL-S058": "FTP refresh: no source",
  "PL-S059": "FTP refresh failed",
  "PL-S060": "FTP source conflict",
  "PL-S061": "Manual FTP validation",
  "PL-S062": "FTP accepted",
  "PL-S063": "Race Course picker",
  "PL-S064": "Race Course parsing",
  "PL-S065": "Unreadable Race Course",
  "PL-S066": "Race Course replacement",
  "PL-S067": "Course missing elevation",
  "PL-S068": "Course recalculating",
  "PL-S069": "Course recalculation failed",
  "PL-S070": "Course-aware Draft",
  "PL-S071": "Estimated CP tooltip",
  "PL-S072": "Estimated CP efforts",
  "PL-S073": "Route assumptions",
  "PL-S074": "Readiness · at risk",
  "PL-S075": "Readiness · missing estimate",
  "PL-S076": "Readiness · Form unavailable",
  "PL-S077": "Readiness · assumptions changed",
  "PL-S078": "Readiness · taper refusal",
  "PL-S079": "Replacement interview",
  "PL-S080": "Replacement Draft",
  "PL-S081": "Replacement confirmation",
  "PL-S082": "Old cleanup barrier",
  "PL-S083": "Old cleanup failed",
  "PL-S084": "Old cleanup retrying",
  "PL-S085": "Old cleanup verified",
  "PL-S086": "Replacement mirror writing",
  "PL-S087": "Replacement history",
  "PL-S088": "Replacement active Plan",
  "PL-S089": "Ended Plan · cleanup verified",
  "PL-S090": "Plan settings",
  "PL-S091": "Plan setting saving",
  "PL-S092": "Plan setting saved",
  "PL-S093": "Plan setting failed",
  "PL-S094": "Natural Plan completion",
  "PL-S095": "Race outcome choice",
  "PL-S096": "Race not completed",
  "PL-S097": "Proposal rejected",
  "PL-S098": "Readiness · refreshing Form",
  "PL-S100": "Weekly review delivered",
  "PL-S101": "Auto-applied Workout reduction",
  "PL-S102": "Ended Plan conversation in History",
  "PL-S103": "Replacement coach ready to create Draft",
  "PL-S104": "Course omission could not be saved",
  "PL-S105": "Replacement Draft forming",
};

const t = (...ids: PlanTransitionId[]): readonly PlanTransitionId[] => ids;

const EXPECTED_TRANSITIONS: Readonly<Record<PlanOwnedScenarioId, readonly PlanTransitionId[]>> = {
  "PL-S001": t("PL-T01"),
  "PL-S002": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T11"),
  "PL-S003": t("PL-T04"),
  "PL-S004": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S005": t("PL-T21", "PL-T39"),
  "PL-S006": t("PL-T31", "PL-T39"),
  "PL-S007": t("PL-T18", "PL-T19", "PL-T20", "PL-T39"),
  "PL-S008": t("PL-T21", "PL-T39"),
  "PL-S009": t("PL-T13", "PL-T39"),
  "PL-S010": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S011": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S012": t("PL-T39"),
  "PL-S013": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S014": t("PL-T01"),
  "PL-S015": t("PL-T08", "PL-T39"),
  "PL-S016": t("PL-T02", "PL-T03", "PL-T05", "PL-T06", "PL-T39"),
  "PL-S017": t("PL-T02", "PL-T03", "PL-T05", "PL-T39"),
  "PL-S018": t(),
  "PL-S019": t("PL-T10", "PL-T39"),
  "PL-S020": t("PL-T02", "PL-T05", "PL-T39"),
  "PL-S021": t("PL-T14", "PL-T39"),
  "PL-S022": t("PL-T18", "PL-T39"),
  "PL-S023": t("PL-T18", "PL-T19", "PL-T20", "PL-T39"),
  "PL-S024": t(),
  "PL-S025": t("PL-T18", "PL-T19", "PL-T20", "PL-T39"),
  "PL-S026": t("PL-T39"),
  "PL-S027": t("PL-T39"),
  "PL-S028": t("PL-T34"),
  "PL-S029": t("PL-T07"),
  "PL-S030": t(),
  "PL-S031": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T11"),
  "PL-S032": t("PL-T15", "PL-T16"),
  "PL-S033": t(),
  "PL-S034": t("PL-T39"),
  "PL-S035": t(),
  "PL-S036": t("PL-T39"),
  "PL-S037": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S038": t(),
  "PL-S039": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S040": t(),
  "PL-S041": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S042": t(),
  "PL-S043": t("PL-T13", "PL-T17", "PL-T23", "PL-T25", "PL-T31", "PL-T32", "PL-T33", "PL-T39"),
  "PL-S044": t("PL-T08"),
  "PL-S045": t("PL-T08"),
  "PL-S046": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T11"),
  "PL-S047": t(),
  "PL-S048": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T11"),
  "PL-S049": t(),
  "PL-S050": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T11"),
  "PL-S051": t("PL-T24", "PL-T39"),
  "PL-S052": t(),
  "PL-S053": t("PL-T24"),
  "PL-S054": t(),
  "PL-S055": t(),
  "PL-S056": t("PL-T01"),
  "PL-S057": t(),
  "PL-S058": t("PL-T04"),
  "PL-S059": t("PL-T04"),
  "PL-S060": t("PL-T04"),
  "PL-S061": t("PL-T04"),
  "PL-S062": t("PL-T04"),
  "PL-S063": t("PL-T02", "PL-T09", "PL-T39"),
  "PL-S064": t(),
  "PL-S065": t("PL-T02", "PL-T03", "PL-T09"),
  "PL-S066": t("PL-T02", "PL-T09", "PL-T39"),
  "PL-S067": t("PL-T02", "PL-T03", "PL-T09"),
  "PL-S068": t(),
  "PL-S069": t("PL-T02", "PL-T03", "PL-T09"),
  "PL-S070": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T11"),
  "PL-S071": t("PL-T39"),
  "PL-S072": t("PL-T39"),
  "PL-S073": t("PL-T39"),
  "PL-S074": t("PL-T39"),
  "PL-S075": t("PL-T39"),
  "PL-S076": t("PL-T32", "PL-T39"),
  "PL-S077": t("PL-T39"),
  "PL-S078": t("PL-T39"),
  "PL-S079": t("PL-T02", "PL-T03", "PL-T05", "PL-T39"),
  "PL-S080": t("PL-T07", "PL-T08", "PL-T09", "PL-T10", "PL-T26"),
  "PL-S081": t("PL-T26", "PL-T39"),
  "PL-S082": t(),
  "PL-S083": t("PL-T27"),
  "PL-S084": t(),
  "PL-S085": t("PL-T28"),
  "PL-S086": t(),
  "PL-S087": t("PL-T39"),
  "PL-S088": t("PL-T13", "PL-T17", "PL-T23", "PL-T25", "PL-T31", "PL-T32", "PL-T33", "PL-T39"),
  "PL-S089": t("PL-T01", "PL-T39"),
  "PL-S090": t("PL-T22", "PL-T39"),
  "PL-S091": t(),
  "PL-S092": t("PL-T22", "PL-T39"),
  "PL-S093": t("PL-T22", "PL-T39"),
  "PL-S094": t("PL-T01", "PL-T39"),
  "PL-S095": t("PL-T30"),
  "PL-S096": t("PL-T01"),
  "PL-S097": t(
    "PL-T12",
    "PL-T13",
    "PL-T17",
    "PL-T23",
    "PL-T25",
    "PL-T31",
    "PL-T32",
    "PL-T33",
    "PL-T39",
  ),
  "PL-S098": t(),
  "PL-S100": t("PL-T39"),
  "PL-S101": t("PL-T21", "PL-T39"),
  "PL-S102": t("PL-T39"),
  "PL-S103": t("PL-T02", "PL-T03", "PL-T05", "PL-T06", "PL-T39"),
  "PL-S104": t("PL-T03", "PL-T39"),
  "PL-S105": t(),
};

const INTERACTION_SCENARIOS = new Set<PlanOwnedScenarioId>([
  "PL-S005",
  "PL-S006",
  "PL-S007",
  "PL-S009",
  "PL-S012",
  "PL-S015",
  "PL-S019",
  "PL-S021",
  "PL-S022",
  "PL-S028",
  "PL-S029",
  "PL-S032",
  "PL-S044",
  "PL-S045",
  "PL-S051",
  "PL-S063",
  "PL-S066",
  "PL-S071",
  "PL-S072",
  "PL-S073",
  "PL-S081",
  "PL-S090",
  "PL-S102",
]);

const IN_FLIGHT_SCENARIOS = new Set<PlanOwnedScenarioId>([
  "PL-S018",
  "PL-S024",
  "PL-S030",
  "PL-S033",
  "PL-S035",
  "PL-S038",
  "PL-S040",
  "PL-S042",
  "PL-S047",
  "PL-S049",
  "PL-S052",
  "PL-S054",
  "PL-S055",
  "PL-S057",
  "PL-S064",
  "PL-S068",
  "PL-S084",
  "PL-S086",
  "PL-S091",
  "PL-S098",
  "PL-S105",
]);

const ENTRY_TRANSITIONS: Partial<Record<PlanOwnedScenarioId, PlanTransitionId>> = {
  "PL-S002": "PL-T06",
  "PL-S008": "PL-T19",
  "PL-S017": "PL-T01",
  "PL-S018": "PL-T06",
  "PL-S024": "PL-T19",
  "PL-S030": "PL-T07",
  "PL-S033": "PL-T15",
  "PL-S035": "PL-T16",
  "PL-S037": "PL-T11",
  "PL-S038": "PL-T12",
  "PL-S040": "PL-T12",
  "PL-S042": "PL-T12",
  "PL-S047": "PL-T08",
  "PL-S049": "PL-T08",
  "PL-S052": "PL-T24",
  "PL-S054": "PL-T24",
  "PL-S055": "PL-T24",
  "PL-S057": "PL-T04",
  "PL-S064": "PL-T02",
  "PL-S068": "PL-T09",
  "PL-S082": "PL-T26",
  "PL-S084": "PL-T27",
  "PL-S086": "PL-T28",
  "PL-S091": "PL-T22",
  "PL-S097": "PL-T20",
  "PL-S098": "PL-T32",
  "PL-S100": "PL-T35",
  "PL-S101": "PL-T38",
  "PL-S105": "PL-T06",
};

const RETRY_TRANSITIONS: Partial<Record<PlanOwnedScenarioId, PlanTransitionId>> = {
  "PL-S039": "PL-T12",
  "PL-S041": "PL-T12",
  "PL-S048": "PL-T08",
  "PL-S053": "PL-T24",
  "PL-S059": "PL-T04",
  "PL-S065": "PL-T02",
  "PL-S069": "PL-T09",
  "PL-S083": "PL-T27",
  "PL-S093": "PL-T22",
  "PL-S104": "PL-T03",
};

const DISMISS_EXPECTATIONS: Partial<
  Record<
    PlanOwnedScenarioId,
    {
      readonly kind: "back" | "cancel" | "close";
      readonly destinationScenarioId: PlanOwnedScenarioId;
      readonly focusTarget: string;
    }
  >
> = {
  "PL-S005": {
    kind: "back",
    destinationScenarioId: "PL-S004",
    focusTarget: "plan-history-trigger",
  },
  "PL-S006": { kind: "back", destinationScenarioId: "PL-S004", focusTarget: "plan-season-trigger" },
  "PL-S007": {
    kind: "close",
    destinationScenarioId: "PL-S004",
    focusTarget: "workout-row-workout-6",
  },
  "PL-S009": {
    kind: "back",
    destinationScenarioId: "PL-S006",
    focusTarget: "plan-race-week-trigger",
  },
  "PL-S012": {
    kind: "back",
    destinationScenarioId: "PL-S004",
    focusTarget: "plan-readiness-trigger",
  },
  "PL-S015": {
    kind: "cancel",
    destinationScenarioId: "PL-S002",
    focusTarget: "plan-start-date-trigger",
  },
  "PL-S016": { kind: "back", destinationScenarioId: "PL-S001", focusTarget: "plan-start-coach" },
  "PL-S017": { kind: "close", destinationScenarioId: "PL-S001", focusTarget: "plan-start-coach" },
  "PL-S019": {
    kind: "cancel",
    destinationScenarioId: "PL-S002",
    focusTarget: "plan-discard-trigger",
  },
  "PL-S021": { kind: "close", destinationScenarioId: "PL-S004", focusTarget: "workout-row" },
  "PL-S022": {
    kind: "close",
    destinationScenarioId: "PL-S004",
    focusTarget: "workout-row-workout-6",
  },
  "PL-S023": {
    kind: "close",
    destinationScenarioId: "PL-S004",
    focusTarget: "workout-row-workout-6",
  },
  "PL-S025": {
    kind: "close",
    destinationScenarioId: "PL-S004",
    focusTarget: "workout-row-workout-6",
  },
  "PL-S051": { kind: "cancel", destinationScenarioId: "PL-S004", focusTarget: "plan-end-trigger" },
  "PL-S071": { kind: "close", destinationScenarioId: "PL-S012", focusTarget: "estimated-cp-info" },
  "PL-S072": {
    kind: "close",
    destinationScenarioId: "PL-S012",
    focusTarget: "estimated-cp-efforts",
  },
  "PL-S073": { kind: "close", destinationScenarioId: "PL-S012", focusTarget: "route-assumptions" },
  "PL-S079": {
    kind: "close",
    destinationScenarioId: "PL-S004",
    focusTarget: "plan-replace-trigger",
  },
  "PL-S081": {
    kind: "cancel",
    destinationScenarioId: "PL-S080",
    focusTarget: "plan-approve-replacement",
  },
  "PL-S090": {
    kind: "back",
    destinationScenarioId: "PL-S005",
    focusTarget: "plan-settings-trigger",
  },
  "PL-S097": {
    kind: "back",
    destinationScenarioId: "PL-S004",
    focusTarget: "workout-row-workout-6",
  },
  "PL-S102": {
    kind: "back",
    destinationScenarioId: "PL-S089",
    focusTarget: "plan-ended-conversation-trigger",
  },
  "PL-S103": {
    kind: "back",
    destinationScenarioId: "PL-S004",
    focusTarget: "plan-replace-trigger",
  },
};

const SOURCE_SCENARIOS: Partial<Record<PlanOwnedScenarioId, PlanOwnedScenarioId>> = {
  "PL-S005": "PL-S004",
  "PL-S006": "PL-S004",
  "PL-S007": "PL-S004",
  "PL-S009": "PL-S004",
  "PL-S012": "PL-S004",
  "PL-S015": "PL-S002",
  "PL-S018": "PL-S016",
  "PL-S019": "PL-S002",
  "PL-S022": "PL-S007",
  "PL-S024": "PL-S007",
  "PL-S029": "PL-S002",
  "PL-S032": "PL-S004",
  "PL-S030": "PL-S029",
  "PL-S033": "PL-S032",
  "PL-S035": "PL-S032",
  "PL-S038": "PL-S037",
  "PL-S040": "PL-S039",
  "PL-S044": "PL-S015",
  "PL-S045": "PL-S015",
  "PL-S047": "PL-S002",
  "PL-S049": "PL-S048",
  "PL-S052": "PL-S051",
  "PL-S054": "PL-S053",
  "PL-S055": "PL-S053",
  "PL-S057": "PL-S003",
  "PL-S063": "PL-S017",
  "PL-S064": "PL-S063",
  "PL-S066": "PL-S070",
  "PL-S068": "PL-S002",
  "PL-S071": "PL-S012",
  "PL-S072": "PL-S012",
  "PL-S073": "PL-S012",
  "PL-S081": "PL-S080",
  "PL-S084": "PL-S083",
  "PL-S086": "PL-S085",
  "PL-S091": "PL-S090",
  "PL-S098": "PL-S012",
  "PL-S102": "PL-S089",
  "PL-S105": "PL-S103",
  "PL-S008": "PL-S007",
  "PL-S010": "PL-S037",
  "PL-S011": "PL-S004",
  "PL-S021": "PL-S004",
  "PL-S023": "PL-S022",
  "PL-S025": "PL-S024",
  "PL-S026": "PL-S005",
  "PL-S027": "PL-S026",
  "PL-S028": "PL-S004",
  "PL-S034": "PL-S033",
  "PL-S036": "PL-S035",
  "PL-S042": "PL-S041",
  "PL-S043": "PL-S042",
  "PL-S048": "PL-S047",
  "PL-S050": "PL-S049",
  "PL-S051": "PL-S004",
  "PL-S056": "PL-S054",
  "PL-S058": "PL-S057",
  "PL-S059": "PL-S057",
  "PL-S060": "PL-S057",
  "PL-S061": "PL-S057",
  "PL-S062": "PL-S057",
  "PL-S065": "PL-S064",
  "PL-S067": "PL-S064",
  "PL-S069": "PL-S068",
  "PL-S070": "PL-S068",
  "PL-S074": "PL-S012",
  "PL-S075": "PL-S012",
  "PL-S076": "PL-S012",
  "PL-S077": "PL-S012",
  "PL-S078": "PL-S012",
  "PL-S087": "PL-S086",
  "PL-S090": "PL-S005",
  "PL-S092": "PL-S091",
  "PL-S093": "PL-S091",
  "PL-S094": "PL-S004",
  "PL-S095": "PL-S094",
  "PL-S097": "PL-S007",
  "PL-S100": "PL-S004",
  "PL-S101": "PL-S004",
  "PL-S104": "PL-S017",
};

const COLD_SCENARIOS = new Set<PlanOwnedScenarioId>([
  "PL-S001",
  "PL-S002",
  "PL-S003",
  "PL-S004",
  "PL-S013",
  "PL-S014",
  "PL-S016",
  "PL-S017",
  "PL-S018",
  "PL-S020",
  "PL-S030",
  "PL-S031",
  "PL-S037",
  "PL-S039",
  "PL-S041",
  "PL-S042",
  "PL-S046",
  "PL-S052",
  "PL-S053",
  "PL-S055",
  "PL-S079",
  "PL-S080",
  "PL-S082",
  "PL-S083",
  "PL-S084",
  "PL-S085",
  "PL-S086",
  "PL-S088",
  "PL-S089",
  "PL-S095",
  "PL-S096",
  "PL-S103",
  "PL-S105",
]);

function classification(id: PlanOwnedScenarioId): PlanQaScenarioClassification {
  if (id === "PL-S011") return "dimension";
  if (IN_FLIGHT_SCENARIOS.has(id)) return "in-flight";
  if (INTERACTION_SCENARIOS.has(id)) return "interaction";
  return "server";
}

function mutationBoundary(transitions: readonly PlanTransitionId[]): PlanQaMutationBoundary {
  if (transitions.some((id) => ["PL-T12", "PL-T16", "PL-T24", "PL-T27", "PL-T28"].includes(id))) {
    return "provider-after-local";
  }
  if (
    transitions.some((id) =>
      [
        "PL-T11",
        "PL-T14",
        "PL-T15",
        "PL-T17",
        "PL-T18",
        "PL-T19",
        "PL-T20",
        "PL-T21",
        "PL-T22",
        "PL-T23",
        "PL-T25",
        "PL-T26",
        "PL-T29",
        "PL-T30",
        "PL-T35",
        "PL-T38",
      ].includes(id),
    )
  ) {
    return "plan-local";
  }
  if (
    transitions.some((id) =>
      [
        "PL-T02",
        "PL-T03",
        "PL-T04",
        "PL-T05",
        "PL-T06",
        "PL-T07",
        "PL-T08",
        "PL-T09",
        "PL-T10",
      ].includes(id),
    )
  ) {
    return "draft-local";
  }
  return "none";
}

const CONVERSATION_FACT_SCENARIOS = new Set<PlanOwnedScenarioId>([
  "PL-S003",
  "PL-S016",
  "PL-S017",
  "PL-S020",
  "PL-S057",
  "PL-S058",
  "PL-S059",
  "PL-S060",
  "PL-S061",
  "PL-S062",
  "PL-S079",
  "PL-S103",
  "PL-S104",
]);

const DRAFT_FACT_SCENARIOS = new Set<PlanOwnedScenarioId>([
  "PL-S002",
  "PL-S015",
  "PL-S018",
  "PL-S019",
  "PL-S029",
  "PL-S030",
  "PL-S031",
  "PL-S044",
  "PL-S045",
  "PL-S046",
  "PL-S047",
  "PL-S048",
  "PL-S049",
  "PL-S050",
  "PL-S063",
  "PL-S064",
  "PL-S065",
  "PL-S066",
  "PL-S067",
  "PL-S068",
  "PL-S069",
  "PL-S070",
  "PL-S080",
  "PL-S081",
  "PL-S105",
]);

const ENDED_FACT_SCENARIOS = new Set<PlanOwnedScenarioId>([
  "PL-S014",
  "PL-S052",
  "PL-S053",
  "PL-S054",
  "PL-S055",
  "PL-S056",
  "PL-S089",
  "PL-S094",
  "PL-S095",
  "PL-S096",
  "PL-S102",
]);

function persistedFacts(id: PlanOwnedScenarioId): PlanQaScenarioExpectation["persistedFacts"] {
  if (id === "PL-S001") return "none";
  if (CONVERSATION_FACT_SCENARIOS.has(id)) return "conversation";
  if (DRAFT_FACT_SCENARIOS.has(id)) return "draft";
  if (ENDED_FACT_SCENARIOS.has(id)) return "ended-plan";
  return "active-plan";
}

function definition(id: PlanOwnedScenarioId): PlanQaScenarioDefinition {
  const kind = classification(id);
  const transitions = EXPECTED_TRANSITIONS[id];
  const entryTransitionId = ENTRY_TRANSITIONS[id] ?? null;
  const hold =
    kind !== "in-flight"
      ? null
      : id === "PL-S042"
        ? "resumed"
        : [
              "PL-S018",
              "PL-S024",
              "PL-S030",
              "PL-S033",
              "PL-S035",
              "PL-S047",
              "PL-S049",
              "PL-S057",
              "PL-S064",
              "PL-S068",
              "PL-S091",
              "PL-S098",
              "PL-S105",
            ].includes(id)
          ? "submitting"
          : "running";
  const boundary = mutationBoundary(
    entryTransitionId === null ? transitions : [...transitions, entryTransitionId],
  );
  const dismiss = DISMISS_EXPECTATIONS[id] ?? null;
  return Object.freeze({
    id,
    name: SCENARIO_NAMES[id],
    classification: kind,
    source:
      kind === "interaction"
        ? "renderer-state"
        : kind === "in-flight"
          ? "progress-event"
          : kind === "dimension"
            ? "display-mode"
            : "planning-read-model",
    sourceScenarioId: SOURCE_SCENARIOS[id] ?? null,
    entryTransitionId,
    entry:
      kind === "interaction"
        ? `Open ${SCENARIO_NAMES[id]} from ${SOURCE_SCENARIOS[id] ?? "its owning surface"}`
        : kind === "in-flight"
          ? `Start ${entryTransitionId}`
          : kind === "dimension"
            ? "Apply the Dark display preference"
            : "Hydrate or complete the owning Planning operation",
    action:
      kind === "dimension"
        ? "Switch theme"
        : transitions.length === 0
          ? "Observe progress until the durable result arrives"
          : `Exercise ${transitions.join(", ")}`,
    expectedTransitions: transitions,
    expectation: Object.freeze({
      persistedFacts: persistedFacts(id),
      transient: hold ?? "none",
      visibleHeading: SCENARIO_NAMES[id],
      visibleActions: transitions,
      retryTransitionId: RETRY_TRANSITIONS[id] ?? null,
      dismiss:
        dismiss === null ? null : Object.freeze({ ...dismiss, transitionId: "PL-T39" as const }),
      localMutation: boundary !== "none",
      providerMutation: boundary === "provider-after-local",
    }),
    accessibility:
      kind === "interaction"
        ? "Move focus into the opened surface and restore the initiating control on close"
        : kind === "in-flight"
          ? "Announce progress without moving focus or exposing duplicate actions"
          : "Expose the visible heading, status, and enabled actions to assistive technology",
    status: "executable",
    recovery:
      kind === "in-flight"
        ? "Resume idempotently or return to the preserved source state"
        : "Keep the last durable state and use the recorded Back, Cancel, Close, or Retry action",
    mutationBoundary: boundary,
    cold: COLD_SCENARIOS.has(id),
    hold,
    theme: id === "PL-S011" ? "dark" : null,
  });
}

export const PLAN_QA_SCENARIOS = Object.freeze(PLAN_OWNED_SCENARIO_IDS.map(definition));
const REGISTRY = new Map(PLAN_QA_SCENARIOS.map((entry) => [entry.id, entry]));

export function planQaScenario(value: string): PlanQaScenarioDefinition {
  const parsed = PlanScenarioIdSchema.safeParse(value);
  if (!parsed.success || parsed.data === "PL-S099") {
    throw new TypeError(`unknown Plan-owned QA Scenario ${value}`);
  }
  const entry = REGISTRY.get(parsed.data);
  if (entry === undefined) throw new TypeError(`unmodeled Plan-owned QA Scenario ${value}`);
  return entry;
}

export function planQaSeedScenarioId(value: string): PlanOwnedScenarioId {
  let entry = planQaScenario(value);
  const visited = new Set<PlanOwnedScenarioId>();
  while (!entry.cold) {
    if (visited.has(entry.id)) throw new TypeError(`cyclic Plan QA source at ${entry.id}`);
    visited.add(entry.id);
    if (entry.sourceScenarioId === null) {
      throw new TypeError(`Plan QA Scenario ${entry.id} has no executable source`);
    }
    entry = planQaScenario(entry.sourceScenarioId);
  }
  return entry.id;
}

export function assertPlanQaTransition(
  scenarioValue: string,
  transitionValue: string,
): PlanTransitionId {
  const entry = planQaScenario(scenarioValue);
  if (!PLAN_TRANSITION_IDS.includes(transitionValue as PlanTransitionId)) {
    throw new TypeError(`unknown Plan transition ${transitionValue}`);
  }
  const transitionId = transitionValue as PlanTransitionId;
  if (!entry.expectedTransitions.includes(transitionId)) {
    throw new TypeError(`unexpected ${transitionId} from ${entry.id}`);
  }
  return transitionId;
}

export type PlanQaTransitionOutcome =
  | "success"
  | "failure"
  | "repeated-failure"
  | "resumed"
  | "no-source"
  | "conflict"
  | "validation"
  | "not-completed";

export function planQaOutcomeIsRejected(outcome: PlanQaTransitionOutcome): boolean {
  return outcome === "failure" || outcome === "repeated-failure" || outcome === "validation";
}

export function planQaOutcomeError(outcome: PlanQaTransitionOutcome): PlanError {
  if (outcome === "validation") {
    return {
      code: "invalid-input",
      message: "The submitted value is not valid.",
      retryable: false,
    };
  }
  if (outcome === "repeated-failure") {
    return {
      code: "verification-failed",
      message: "The operation still needs attention.",
      retryable: true,
    };
  }
  return {
    code: "persistence-failed",
    message: "The operation could not be saved.",
    retryable: true,
  };
}

export function planQaTransitionResult(
  outcome: PlanQaTransitionOutcome,
  state: PlanReadModel,
): Extract<ExecutePlanTransitionRpcResult, { status: "completed" | "rejected" }> {
  return planQaOutcomeIsRejected(outcome)
    ? { status: "rejected", error: planQaOutcomeError(outcome), state }
    : { status: "completed", state };
}

export interface PlanQaTransitionDestination {
  readonly progressScenarioIds: readonly PlanOwnedScenarioId[];
  readonly terminalScenarioId: PlanOwnedScenarioId;
}

export function resolvePlanQaTransition(
  scenarioValue: string,
  transitionValue: string,
  options: {
    readonly outcome?: PlanQaTransitionOutcome;
    readonly destinationScenarioId?: string;
    readonly intakeStatus?: "incomplete" | "ready";
    readonly courseChoice?: "undecided" | "resolved";
    readonly attentionId?: string;
  } = {},
): PlanQaTransitionDestination {
  const transitionId = assertPlanQaTransition(scenarioValue, transitionValue);
  const current = planQaScenario(scenarioValue);
  const outcome = options.outcome ?? "success";
  const rejected = planQaOutcomeIsRejected(outcome);
  const destination = (
    terminalScenarioId: PlanOwnedScenarioId,
    progressScenarioIds: readonly PlanOwnedScenarioId[] = [],
  ): PlanQaTransitionDestination => ({ terminalScenarioId, progressScenarioIds });
  const replacementInterview = current.id === "PL-S079" || current.id === "PL-S103";
  const interviewScenarioId = replacementInterview ? "PL-S079" : "PL-S017";
  const readyScenarioId = replacementInterview ? "PL-S103" : "PL-S016";
  const alreadyReady = current.id === "PL-S016" || current.id === "PL-S103";
  const intakeReady = alreadyReady || options.intakeStatus === "ready";
  const courseChoiceResolved = alreadyReady || options.courseChoice === "resolved";
  switch (transitionId) {
    case "PL-T01":
      return destination("PL-S017");
    case "PL-T02":
      return outcome === "failure"
        ? destination("PL-S065", ["PL-S064"])
        : destination(intakeReady ? readyScenarioId : interviewScenarioId, ["PL-S064"]);
    case "PL-T03":
      return outcome === "failure"
        ? destination("PL-S104")
        : destination(intakeReady ? readyScenarioId : interviewScenarioId);
    case "PL-T04":
      if (outcome === "failure") return destination("PL-S059", ["PL-S057"]);
      if (outcome === "no-source") return destination("PL-S058", ["PL-S057"]);
      if (outcome === "conflict") return destination("PL-S060", ["PL-S057"]);
      if (outcome === "validation") return destination("PL-S061");
      return destination("PL-S062", ["PL-S057"]);
    case "PL-T05":
      return destination(
        intakeReady && courseChoiceResolved ? readyScenarioId : interviewScenarioId,
      );
    case "PL-T06":
      if (rejected) return destination(current.id === "PL-S103" ? "PL-S103" : "PL-S016");
      return current.id === "PL-S103" || current.id === "PL-S105"
        ? destination("PL-S080", ["PL-S105"])
        : destination("PL-S002", ["PL-S018"]);
    case "PL-T07":
      if (rejected) {
        return destination(
          current.id === "PL-S029" ? (SOURCE_SCENARIOS[current.id] ?? current.id) : current.id,
        );
      }
      return destination("PL-S031", ["PL-S030"]);
    case "PL-T08":
      return outcome === "failure"
        ? destination("PL-S048", ["PL-S047"])
        : destination("PL-S050", ["PL-S047"]);
    case "PL-T09":
      return outcome === "failure"
        ? destination("PL-S069", ["PL-S068"])
        : destination("PL-S070", ["PL-S068"]);
    case "PL-T10":
      return destination("PL-S020");
    case "PL-T11":
      if (rejected) return destination(current.id);
      return destination("PL-S037");
    case "PL-T12":
      if (outcome === "failure") return destination("PL-S039", ["PL-S038"]);
      if (outcome === "repeated-failure") return destination("PL-S041", ["PL-S040"]);
      if (outcome === "resumed") return destination("PL-S043", ["PL-S042"]);
      return destination("PL-S043", ["PL-S038"]);
    case "PL-T13":
      return destination("PL-S021");
    case "PL-T14":
      return destination("PL-S004");
    case "PL-T15":
      if (rejected) return destination("PL-S032");
      return destination("PL-S034", ["PL-S033"]);
    case "PL-T16":
      if (rejected) return destination("PL-S032");
      return destination("PL-S036", ["PL-S035"]);
    case "PL-T17":
      return destination("PL-S007");
    case "PL-T18":
      if (rejected) {
        return destination(
          current.id === "PL-S022" ? (SOURCE_SCENARIOS[current.id] ?? current.id) : current.id,
        );
      }
      return destination("PL-S023");
    case "PL-T19":
      return outcome === "failure"
        ? destination("PL-S025", ["PL-S024"])
        : destination("PL-S008", ["PL-S024"]);
    case "PL-T20":
      return destination("PL-S097");
    case "PL-T21":
      return outcome === "failure" ? destination("PL-S026") : destination("PL-S027");
    case "PL-T22":
      return outcome === "failure"
        ? destination("PL-S093", ["PL-S091"])
        : destination("PL-S092", ["PL-S091"]);
    case "PL-T23":
      return destination("PL-S051");
    case "PL-T24":
      return outcome === "failure"
        ? destination("PL-S053", ["PL-S052"])
        : destination("PL-S056", ["PL-S052", "PL-S054"]);
    case "PL-T25":
      return destination("PL-S079");
    case "PL-T26":
      return destination(current.id === "PL-S080" ? "PL-S081" : "PL-S082");
    case "PL-T27":
      return outcome === "failure"
        ? destination("PL-S083", ["PL-S084"])
        : destination("PL-S085", ["PL-S084"]);
    case "PL-T28":
      return destination("PL-S087", ["PL-S086"]);
    case "PL-T29":
      return destination("PL-S094");
    case "PL-T30":
      if (rejected) return destination("PL-S095");
      return destination(outcome === "not-completed" ? "PL-S096" : "PL-S014");
    case "PL-T31":
      return destination(current.id === "PL-S006" ? "PL-S009" : "PL-S006");
    case "PL-T32":
      return destination("PL-S012", current.id === "PL-S012" ? ["PL-S098"] : []);
    case "PL-T33":
      return destination("PL-S028");
    case "PL-T34":
      return destination(
        options.attentionId?.startsWith("workout-drift:") === true ? "PL-S032" : "PL-S021",
      );
    case "PL-T35":
      return destination("PL-S100");
    case "PL-T38":
      return destination("PL-S101");
    case "PL-T39": {
      if (options.destinationScenarioId === undefined) {
        throw new TypeError("PL-T39 requires a destinationScenarioId");
      }
      const target = planQaScenario(options.destinationScenarioId);
      const acceptedCoachDestination =
        (current.id === "PL-S016" || current.id === "PL-S017") && target.id === "PL-S001"
          ? true
          : (current.id === "PL-S079" || current.id === "PL-S103") && target.id === "PL-S004";
      if (
        ["PL-S016", "PL-S017", "PL-S079", "PL-S103"].includes(current.id) &&
        !acceptedCoachDestination
      ) {
        throw new TypeError(`invalid PL-T39 destination ${target.id} from ${current.id}`);
      }
      return destination(target.id);
    }
    case "PL-T36":
    case "PL-T37":
      throw new TypeError(`${transitionId} is Chat-owned`);
  }
}

const PLAN_ID = "plan-qa";
const PREVIOUS_PLAN_ID = "plan-previous";
const CONVERSATION_ID = "00000000000000000000000001";
const DRAFT_ID = "draft-qa";
const NOW_MS = 903_766_320_000;

const plan = {
  id: PLAN_ID,
  name: "Gran Fondo Almaty",
  primaryGoal: "Finish in the front half",
  startDate: "1998-07-13",
  targetDate: "1998-10-04",
  kind: "full-plan" as const,
  totalWeeks: 12,
  weekStartDay: 1,
  workoutCount: 58,
  plannedDurationS: 309_600,
  phaseSummary: ["Build", "Recovery", "Taper", "Race"],
  ftpWatts: 282,
};

const workouts = [
  ["workout-1", "1998-08-18", "Endurance", 5_400, "as-planned", false],
  ["workout-2", "1998-08-19", "Threshold 4×8", 4_800, "adjusted", false],
  ["workout-3", "1998-08-20", "Easy endurance", 3_000, "moved", false],
  ["workout-4", "1998-08-21", "Recovery", 2_700, "missed", false],
  ["workout-5", "1998-08-22", "Café ride", 7_500, "extra", false],
  ["workout-6", "1998-08-23", "Suggested endurance", 1_800, "decision-needed", true],
].map(([id, date, name, durationS, status, requiresConfirmation], index) => ({
  id: String(id),
  date: String(date),
  sport: "cycling",
  name: String(name),
  durationS: Number(durationS),
  match: {
    kind: status === "extra" ? ("extra" as const) : ("planned" as const),
    status: status as "as-planned" | "adjusted" | "moved" | "missed" | "extra" | "decision-needed",
    activityId: `activity-${index + 1}`,
    matchId: `match-${index + 1}`,
    actualDate: String(date),
    actualDurationS: Number(durationS),
    requiresConfirmation: Boolean(requiresConfirmation),
    createdAtMs: index + 1,
  },
}));

const todayWorkout = {
  ...workouts[3]!,
  id: "today-recovery",
  date: "1998-08-22",
  name: "Recovery spin",
  durationS: 2_700,
  powerTargetW: { min: 130, max: 165 },
  cue: "Keep the pedals light.",
};

const history = [
  {
    id: "history-adjustment",
    kind: "proposal-applied" as const,
    label: "Sunday adjustment applied",
    occurredAtMs: NOW_MS,
    targetWorkoutId: "workout-6",
    before: { date: "1998-08-23", name: "Endurance", durationS: 5_400 },
    after: { date: "1998-08-23", name: "Recovery", durationS: 1_800 },
    weekLoadBefore: 420,
    weekLoadAfter: 360,
    undoStatus: "eligible" as const,
    undoReason: null,
  },
  {
    id: "history-activation",
    kind: "activation" as const,
    label: "Plan approved",
    occurredAtMs: 900_331_200_000,
    targetWorkoutId: null,
    before: null,
    after: null,
    weekLoadBefore: null,
    weekLoadAfter: null,
    undoStatus: "none" as const,
    undoReason: null,
  },
];

const proposal = {
  id: "proposal-qa",
  revision: 1,
  title: "Sunday recovery",
  rationale: "Saturday fatigue is 12 above your normal range.",
  confidence: "High" as const,
  targetWorkoutId: "workout-6",
  affectedDate: "1998-08-23",
  createdAtMs: NOW_MS,
  stale: false,
  diff: [
    { field: "duration" as const, label: "Duration", before: "1:30", after: "0:30" },
    { field: "workout" as const, label: "Workout", before: "Endurance", after: "Recovery" },
    { field: "week-load" as const, label: "Week load", before: "420", after: "360" },
  ],
  premises: [
    {
      id: "premise-qa",
      sourceType: "activity",
      sourceId: "ride-historical",
      sourceLabel: "Saturday ride · 21 Aug · Assioma pedals",
      sourceDate: "1998-08-21",
      confidence: "High" as const,
      snapshotJson: '{"loadAboveNormal":12}',
    },
  ],
  error: null,
};

const seasonDates = [
  ["1998-07-13", "1998-07-19"],
  ["1998-07-20", "1998-07-26"],
  ["1998-07-27", "1998-08-02"],
  ["1998-08-03", "1998-08-09"],
  ["1998-08-10", "1998-08-16"],
  ["1998-08-17", "1998-08-23"],
  ["1998-08-24", "1998-08-30"],
  ["1998-08-31", "1998-09-06"],
  ["1998-09-07", "1998-09-13"],
  ["1998-09-14", "1998-09-20"],
  ["1998-09-21", "1998-09-27"],
  ["1998-09-28", "1998-10-04"],
] as const;

const seasonWeeks = seasonDates.map(([startDate, endDate], index) => ({
  weekIndex: index + 1,
  startDate,
  endDate,
  phase: index === 11 ? "Race" : index >= 10 ? "Taper" : index === 3 ? "Recovery" : "Build",
  purpose: index === 11 ? "Goal race" : "Follow the approved week",
  status:
    index === 5 ? ("current" as const) : index < 5 ? ("completed" as const) : ("planned" as const),
  plannedDurationS: index === 11 ? 29_100 : 32_400,
}));

const raceWeek = {
  startDate: "1998-09-28",
  endDate: "1998-10-04",
  raceDate: "1998-10-04",
  trainingDurationS: 11_100,
  raceDurationS: 18_000,
  totalDurationS: 29_100,
  days: [
    ["1998-09-28", "Mon", null, "Rest", null, "Absorb", "rest"],
    ["1998-09-29", "Tue", "race-1", "Openers · 3×1 min", 2_700, "Sharpen", "training"],
    ["1998-09-30", "Wed", "race-2", "Easy endurance", 3_000, "Maintain", "training"],
    ["1998-10-01", "Thu", null, "Rest", null, "Freshen", "rest"],
    ["1998-10-02", "Fri", "race-3", "Race opener", 1_800, "Sharpen", "training"],
    ["1998-10-03", "Sat", "race-4", "Pre-race spin", 3_600, "Prime", "training"],
    ["1998-10-04", "Sun", "race-5", "Gran Fondo Almaty", 18_000, "Race", "race"],
  ].map(([date, weekday, workoutId, name, durationS, purpose, kind]) => ({
    date: String(date),
    weekday: weekday as "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun",
    workoutId: workoutId === null ? null : String(workoutId),
    name: String(name),
    durationS: durationS === null ? null : Number(durationS),
    purpose: String(purpose),
    kind: kind as "training" | "rest" | "race",
  })),
};

const readiness = {
  form: {
    status: "available" as const,
    asOf: "1998-08-22",
    current: 1,
    raceRange: { min: 4, max: 9 },
    assumptions: ["Planned load is completed", "Recovery remains normal"],
    unavailableReason: null,
    lastSuccessfulRefreshAtMs: NOW_MS,
  },
  feasibility: {
    verdict: "on-track" as const,
    supportedDistanceKm: { min: 115, max: 130 },
    reasons: ["Training is consistent"],
    recommendation: "Keep the approved taper",
  },
  courseEstimate: {
    status: "available" as const,
    rangeMinutes: { min: 288, max: 312 },
    previousRangeMinutes: null,
    confidence: "moderate" as const,
    assumptions: ["Dry roads", "Low wind", "Planned fueling", "No mechanical delay"],
    changedAssumption: null,
    unavailableReason: null,
  },
  estimatedCp: {
    status: "available" as const,
    watts: 287,
    calculatedOn: "1998-08-22",
    lastSuccessfulSyncAtMs: NOW_MS,
    unavailableReason: null,
    efforts: [
      {
        activityId: "ride-short",
        ride: "Tuesday Hill Repeats",
        date: "1998-08-18",
        durationS: 180,
        averagePowerW: 407,
        device: "Favero Assioma Duo",
      },
      {
        activityId: "ride-long",
        ride: "Sunday Tempo Climb",
        date: "1998-08-09",
        durationS: 900,
        averagePowerW: 311,
        device: "Garmin Rally RS200",
      },
    ],
  },
  evidence: {
    prescribedDurationS: 154_800,
    riddenDurationS: 142_800,
    adjustedDurationS: 7_800,
    missedKeyWorkouts: 0,
    fatigue: "normal" as const,
  },
  taperRefusal: null,
  error: null,
};

const replacement = {
  id: "replacement-qa",
  previousPlan: { ...plan, id: PREVIOUS_PLAN_ID, name: "Previous Gran Fondo Plan" },
  activatedAtMs: NOW_MS,
  cleanupItems: [
    {
      id: "cleanup-old-plan",
      date: "1998-08-23",
      externalId: `cycling-coach:plan:${PREVIOUS_PLAN_ID}:workout`,
      status: "pending" as const,
      errorCode: null,
    },
  ],
};

const activeData: PlanActiveProjectionData = {
  plan,
  today: "1998-08-22",
  weekIndex: 6,
  todayWorkout,
  workouts,
  selectedWorkoutId: null,
  matchSync: { lastSuccessfulSyncAtMs: NOW_MS, awaitingSync: false },
  proposals: [proposal],
  selectedProposalId: null,
  history,
  selectedHistoryId: null,
  settings: {
    autoApply: false,
    weeklyReview: true,
    updatedAtMs: NOW_MS,
    selectedSetting: null,
    error: null,
  },
  weeklyReview: {
    status: "delivered",
    id: "weekly-review-qa",
    weekStart: "1998-08-10",
    weekEnd: "1998-08-16",
    deliveredAtMs: NOW_MS,
    counts: { asPlanned: 3, adjusted: 1, moved: 1, missed: 1, extra: 1 },
    summary: "You completed the key work and adjusted one session for recovery.",
  },
  season: {
    priority: "A",
    distanceKm: 120,
    weeks: seasonWeeks,
    constraint: {
      weekIndex: 8,
      title: "FTP refresh required before Build 2",
      detail: "Later durations stay fixed; power targets wait for refreshed FTP.",
    },
    raceWeek,
  },
  readiness,
};

const emptyReconciliation = {
  status: "not-started" as const,
  created: 0,
  pending: 0,
  failed: 0,
  total: 0,
  currentThrough: null,
  error: null,
};

const conversation = (replacementConversation = false) => ({
  id: CONVERSATION_ID,
  planId: null,
  replacesPlanId: replacementConversation ? PREVIOUS_PLAN_ID : null,
  sourceConversationId: null,
});

const turns = [
  {
    id: "turn-qa",
    athleteText: "Gran Fondo Almaty on 4 October. I can train four days each week.",
    coachText: "I found your recent rides, recovery, weekly availability, and FTP 282 W.",
  },
];

const queue = { schemaVersion: 1 as const, revision: 0, items: [] };

function draft(revision: number, status: "forming" | "ready" | "failed" | "discarded" = "ready") {
  return {
    id: DRAFT_ID,
    planId: PLAN_ID,
    revision,
    status,
    snapshot: { completeWeeks: 12 },
  } as const;
}

function startDate(status: "ready" | "invalid" | "recalculating" | "failed" | "updated" = "ready") {
  if (status === "invalid") {
    return {
      status,
      selectedDate: "1998-10-05",
      today: "1998-07-13",
      targetDate: "1998-10-04",
      kind: null,
      inclusiveDays: null,
      totalWeeks: null,
      raceWeekday: null,
      raceDayOfPlanWeek: null,
      error: {
        code: "invalid-input" as const,
        message: "Choose a date before race day.",
        retryable: true,
      },
    };
  }
  const failed = status === "failed";
  return {
    status,
    selectedDate: status === "updated" ? "1998-07-20" : "1998-07-13",
    today: "1998-07-13",
    targetDate: "1998-10-04",
    kind: status === "updated" ? ("short-race-preparation" as const) : ("full-plan" as const),
    inclusiveDays: status === "updated" ? 77 : 84,
    totalWeeks: status === "updated" ? 11 : 12,
    raceWeekday: 0,
    raceDayOfPlanWeek: 7,
    error: failed
      ? { code: "persistence-failed" as const, message: "Recalculation failed.", retryable: true }
      : null,
  };
}

function lifecycleSeedModel(id: PlanOwnedScenarioId): PlanReadModel {
  if (id === "PL-S001") {
    return buildPlanLifecycleReadModel({
      conversation: null,
      turns: [],
      readyToCreateDraft: false,
      queue,
      decision: null,
      draft: null,
    });
  }
  const isReplacement = ["PL-S079", "PL-S080", "PL-S103", "PL-S105"].includes(id);
  const ready = ["PL-S016", "PL-S103"].includes(id);
  const draftStatus = ["PL-S018", "PL-S030", "PL-S105"].includes(id)
    ? "forming"
    : id === "PL-S020"
      ? "discarded"
      : ["PL-S002", "PL-S031", "PL-S046", "PL-S080"].includes(id)
        ? "ready"
        : null;
  const revision = ["PL-S030", "PL-S031"].includes(id) ? 2 : 1;
  return buildPlanLifecycleReadModel({
    conversation: conversation(isReplacement),
    turns,
    readyToCreateDraft: ready,
    queue,
    decision: null,
    draft: draftStatus === null ? null : draft(revision, draftStatus),
    plan: draftStatus === null || draftStatus === "discarded" ? null : plan,
    ...(id === "PL-S046"
      ? { startDate: startDate("invalid"), dateScenario: "PL-S046" as const }
      : {}),
    ...(id === "PL-S003"
      ? {
          ftp: {
            status: "required" as const,
            manual: null,
            intervalsFtp: null,
            intervalsEftp: null,
            usedSource: null,
            usedWatts: null,
            conflict: false,
            error: null,
          },
        }
      : {}),
    course: {
      status: ready || draftStatus !== null ? "omitted" : "undecided",
      accepted: null,
      candidate: null,
      fileName: null,
      detail: null,
    },
  });
}

function reconciliationFor(id: PlanOwnedScenarioId) {
  if (["PL-S039", "PL-S041", "PL-S083"].includes(id)) {
    return {
      status: "failed" as const,
      created: 3,
      pending: 1,
      failed: 1,
      total: 5,
      currentThrough: null,
      error: {
        code: "provider-failed" as const,
        message: "Calendar update needs attention.",
        retryable: true,
      },
    };
  }
  if (["PL-S042", "PL-S084", "PL-S086"].includes(id)) {
    return {
      status: "running" as const,
      created: 3,
      pending: 2,
      failed: 0,
      total: 5,
      currentThrough: null,
      error: null,
    };
  }
  if (["PL-S085", "PL-S088"].includes(id)) {
    return {
      status: "verified" as const,
      created: 5,
      pending: 0,
      failed: 0,
      total: 5,
      currentThrough: "1998-08-28",
      error: null,
    };
  }
  return emptyReconciliation;
}

function activeSeedModel(id: ActivePlanScenario): PlanReadModel {
  const replacing = ["PL-S082", "PL-S083", "PL-S084", "PL-S085", "PL-S086", "PL-S088"].includes(id);
  const data: PlanActiveProjectionData = {
    ...activeData,
    matchSync:
      id === "PL-S013"
        ? { lastSuccessfulSyncAtMs: NOW_MS, awaitingSync: true }
        : activeData.matchSync,
    ...(replacing
      ? {
          replacement: {
            ...replacement,
            cleanupItems: replacement.cleanupItems.map((item) => ({
              ...item,
              status:
                id === "PL-S083"
                  ? ("failed" as const)
                  : id === "PL-S085" || id === "PL-S086" || id === "PL-S088"
                    ? ("verified" as const)
                    : ("pending" as const),
              errorCode: id === "PL-S083" ? "calendar-delete-failed" : null,
            })),
          },
        }
      : {}),
  };
  return buildActivePlanReadModel({
    scenarioId: id,
    planId: PLAN_ID,
    revision: 1,
    data,
    reconciliation: reconciliationFor(id),
    proposalCapabilities: {
      canRevise: true,
      canVerifyPremises: true,
      canCalculateLoad: true,
    },
  });
}

function endedSeedModel(id: EndedPlanScenario): PlanReadModel {
  const failed = id === "PL-S053";
  const running = id === "PL-S052" || id === "PL-S055";
  const data: PlanEndedProjectionData = {
    plan,
    endedAtMs: NOW_MS,
    raceOutcome: id === "PL-S096" ? "not-completed" : id === "PL-S014" ? "completed" : null,
    ...(id === "PL-S014"
      ? {
          raceOutcomeDetails: {
            outcome: "completed" as const,
            raceDate: "1998-10-04",
            goal: "Front half",
            result: "Front third",
            trainingDurationS: 303_600,
            raceDurationS: 18_180,
            totalDurationS: 321_780,
            modeledFinishMinutes: { min: 288, max: 312 },
            actualDurationS: 18_180,
            appliedChangeCount: 12,
          },
        }
      : id === "PL-S096"
        ? {
            raceOutcomeDetails: {
              outcome: "not-completed" as const,
              raceDate: "1998-10-04",
            },
          }
        : {}),
    outcomeAvailable: id === "PL-S094" || id === "PL-S095",
    cleanupItems: [
      {
        id: "cleanup-qa",
        date: "1998-08-23",
        externalId: "cycling-coach:plan:historical:workout",
        status: failed ? "failed" : running ? "pending" : "verified",
        errorCode: failed ? "calendar-delete-failed" : null,
      },
    ],
  };
  const reconciliation = failed
    ? {
        status: "failed" as const,
        created: 0,
        pending: 0,
        failed: 1,
        total: 1,
        currentThrough: null,
        error: {
          code: "provider-failed" as const,
          message: "Cleanup could not be verified.",
          retryable: true,
        },
      }
    : running
      ? {
          status: "running" as const,
          created: 0,
          pending: 1,
          failed: 0,
          total: 1,
          currentThrough: null,
          error: null,
        }
      : {
          status: "verified" as const,
          created: 1,
          pending: 0,
          failed: 0,
          total: 1,
          currentThrough: "1998-08-28",
          error: null,
        };
  return buildEndedPlanReadModel({
    scenarioId: id,
    planId: PLAN_ID,
    revision: 1,
    data,
    reconciliation,
  });
}

const COLD_LIFECYCLE = new Set<PlanOwnedScenarioId>([
  "PL-S001",
  "PL-S002",
  "PL-S003",
  "PL-S016",
  "PL-S017",
  "PL-S018",
  "PL-S020",
  "PL-S030",
  "PL-S031",
  "PL-S046",
  "PL-S079",
  "PL-S080",
  "PL-S103",
  "PL-S105",
]);

const COLD_ACTIVE = new Set<ActivePlanScenario>([
  "PL-S004",
  "PL-S013",
  "PL-S037",
  "PL-S039",
  "PL-S041",
  "PL-S042",
  "PL-S082",
  "PL-S083",
  "PL-S084",
  "PL-S085",
  "PL-S086",
  "PL-S088",
]);

const COLD_ENDED = new Set<EndedPlanScenario>([
  "PL-S014",
  "PL-S052",
  "PL-S053",
  "PL-S055",
  "PL-S089",
  "PL-S095",
  "PL-S096",
]);

export function createPlanQaSeedModel(value: string): PlanReadModel {
  const seedId = planQaSeedScenarioId(value);
  let model: PlanReadModel;
  if (COLD_LIFECYCLE.has(seedId)) model = lifecycleSeedModel(seedId);
  else if (COLD_ACTIVE.has(seedId as ActivePlanScenario)) {
    model = activeSeedModel(seedId as ActivePlanScenario);
  } else if (COLD_ENDED.has(seedId as EndedPlanScenario)) {
    model = endedSeedModel(seedId as EndedPlanScenario);
  } else {
    throw new TypeError(`no production Plan QA seed model for ${seedId}`);
  }
  const parsed = PlanReadModelSchema.parse(model);
  if (parsed.scenarioId !== seedId) {
    throw new TypeError(`Plan QA seed ${seedId} produced ${parsed.scenarioId}`);
  }
  return parsed;
}
