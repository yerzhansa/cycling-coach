import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadWindowsParityScenarios } from "./windows-parity-scenarios.mjs";

export const WINDOWS_INSTALLED_ACCEPTANCE_MAX_UNBROKEN_TOKEN_RUN = 32;

const unsafeUnbrokenTokenRunPattern = new RegExp(
  `[A-Za-z0-9+/=_-]{${WINDOWS_INSTALLED_ACCEPTANCE_MAX_UNBROKEN_TOKEN_RUN},}`,
  "u",
);
const checklistResults = Object.freeze(["pass", "fail", "incomplete"]);
const uninstallPhaseOrder = Object.freeze(["seed", "uninstall", "reinstall"]);
const resultKinds = Object.freeze({
  installed: "windows-installed-acceptance-result",
  liveSmoke: "windows-installed-live-smoke-result",
});
const evidenceContract = Object.freeze({
  checklistResult: checklistResults,
  evidence: Object.freeze({
    type: "free-text",
    pathPolicy: "path-free",
    credentialPolicy: "credential-free",
  }),
});
const uninstallPhases = Object.freeze([
  Object.freeze({
    id: "seed",
    requirement:
      "Seed every durable class with synthetic acceptance values and record path-free baselines before uninstall.",
  }),
  Object.freeze({
    id: "uninstall",
    requirement:
      "Uninstall and verify program and integration state is removed while both athlete-data and desktop user-data roots remain preserved.",
  }),
  Object.freeze({
    id: "reinstall",
    requirement:
      "Reinstall as the same Windows user, verify every durable class reopens unchanged, verify owning-user DPAPI secrets still decrypt without recording them, and verify transient residue cannot block reinstall or relaunch.",
  }),
]);
const transientInventory = Object.freeze([
  "updater cache and staging",
  "runtime locks",
  "daemon PID and port coordinates",
  "upgrade-fence claim coordinates",
  "crash temporaries",
]);
const preservedDataRoots = Object.freeze(["athlete-data root", "desktop user-data root"]);
const removedIntegrationState = Object.freeze([
  "program installation",
  "Start menu shortcut",
  "Apps list entry",
  "uninstaller",
  "tray process",
  "owned per-user login registration",
]);
const transientAssertion =
  "No transient inventory item may block same-user reinstall or a clean relaunch.";

export const WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES = Object.freeze([
  Object.freeze({
    id: "chatgpt",
    name: "ChatGPT",
    check:
      "Confirm a redacted installed-app exchange succeeds without displaying account or conversation identifiers.",
  }),
  Object.freeze({
    id: "claude-cli",
    name: "Claude CLI",
    check:
      "Confirm a redacted installed-app exchange succeeds without displaying account or conversation identifiers.",
  }),
  Object.freeze({
    id: "intervals-icu",
    name: "Intervals.icu",
    check:
      "Confirm a credential-safe refresh succeeds without displaying athlete or activity identifiers.",
  }),
  Object.freeze({
    id: "telegram",
    name: "Telegram",
    check:
      "Confirm a credential-safe round trip succeeds without displaying bot, chat, or user identifiers.",
  }),
  Object.freeze({
    id: "api-key-provider",
    name: "One API-key provider",
    check:
      "Confirm one configured API-key provider completes a redacted exchange without displaying the key or account identifiers.",
  }),
]);

export class WindowsInstalledAcceptanceError extends Error {
  constructor(stage) {
    super(`windows-installed acceptance refused at ${stage}`);
    this.name = "WindowsInstalledAcceptanceError";
    this.stage = stage;
  }
}

function reject(stage) {
  throw new WindowsInstalledAcceptanceError(stage);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameValues(left, right) {
  return isDeepStrictEqual(left, right);
}

function scenarioCitations(scenario) {
  if (Object.hasOwn(scenario, "test") && typeof scenario.test === "string") {
    return [scenario.test];
  }
  if (
    Object.hasOwn(scenario, "tests") &&
    Array.isArray(scenario.tests) &&
    scenario.tests.every((test) => typeof test === "string")
  ) {
    return [...scenario.tests];
  }
  reject("scenario-citations");
}

function durableClassName(rowId) {
  return rowId.slice("uninstall.durable.".length).replaceAll("-", " ");
}

function createUninstallReinstallSection(scenarios) {
  const uninstallRows = scenarios.filter((scenario) => scenario.id.startsWith("uninstall."));
  const durableRows = uninstallRows.filter((scenario) =>
    scenario.id.startsWith("uninstall.durable."),
  );
  return Object.freeze({
    phaseOrder: uninstallPhaseOrder,
    phases: uninstallPhases,
    rowMappings: Object.freeze(
      uninstallRows.map((scenario) =>
        Object.freeze({ rowId: scenario.id, phases: uninstallPhaseOrder }),
      ),
    ),
    durableInventory: Object.freeze(
      durableRows.map((scenario) =>
        Object.freeze({ rowId: scenario.id, durableClass: durableClassName(scenario.id) }),
      ),
    ),
    preservedDataRoots,
    removedIntegrationState,
    transientInventory,
    transientAssertion,
  });
}

function validateScenarioSource(collection) {
  if (
    !record(collection) ||
    !Array.isArray(collection.manifests) ||
    !collection.manifests.every((manifest) => typeof manifest === "string") ||
    !Array.isArray(collection.scenarios)
  ) {
    reject("plan-input");
  }
  const ids = new Set();
  for (const scenario of collection.scenarios) {
    if (
      !record(scenario) ||
      typeof scenario.id !== "string" ||
      typeof scenario.surface !== "string" ||
      typeof scenario.expected !== "string"
    ) {
      reject("plan-input");
    }
    if (ids.has(scenario.id)) reject("source-duplicate");
    ids.add(scenario.id);
    if (scenario.automation === "deterministic") scenarioCitations(scenario);
    else if (scenario.automation !== "vm-only") reject("automation");
  }
}

export function createWindowsInstalledAcceptancePlan(collection) {
  validateScenarioSource(collection);
  const automatedEvidence = [];
  const manualChecklist = [];
  for (const scenario of collection.scenarios) {
    if (scenario.automation === "deterministic") {
      automatedEvidence.push(
        Object.freeze({
          rowId: scenario.id,
          surface: scenario.surface,
          expected: scenario.expected,
          tests: Object.freeze(scenarioCitations(scenario)),
        }),
      );
    } else if (scenario.automation === "vm-only") {
      manualChecklist.push(
        Object.freeze({
          rowId: scenario.id,
          surface: scenario.surface,
          reason: scenario.expected,
          evidenceContract,
        }),
      );
    } else {
      reject("automation");
    }
  }
  const plan = Object.freeze({
    schemaVersion: 1,
    kind: "windows-installed-acceptance-plan",
    manifests: Object.freeze([...collection.manifests]),
    totals: Object.freeze({
      total: automatedEvidence.length + manualChecklist.length,
      deterministic: automatedEvidence.length,
      vmOnly: manualChecklist.length,
    }),
    automatedEvidence: Object.freeze(automatedEvidence),
    manualChecklist: Object.freeze(manualChecklist),
    uninstallReinstall: createUninstallReinstallSection(collection.scenarios),
    liveSmokeLane: Object.freeze({
      mode: "live-smoke",
      includedInDeterministicLane: false,
      outputPolicy: Object.freeze({ secrets: "never", identifiers: "redacted" }),
      smokes: WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES,
    }),
  });
  validateWindowsInstalledAcceptanceClosure(collection, plan);
  return plan;
}

export async function buildWindowsInstalledAcceptancePlan() {
  return createWindowsInstalledAcceptancePlan(await loadWindowsParityScenarios());
}

function validateCoverageStep(step, scenario, expectedAutomation) {
  if (!record(step) || typeof step.rowId !== "string") reject("coverage-shape");
  if (scenario.automation !== expectedAutomation) reject("coverage-class");
  if (step.surface !== scenario.surface) reject("coverage-content");
  if (expectedAutomation === "deterministic") {
    if (
      !exactKeys(step, ["rowId", "surface", "expected", "tests"]) ||
      step.expected !== scenario.expected ||
      !sameValues(step.tests, scenarioCitations(scenario))
    ) {
      reject("coverage-content");
    }
  } else if (
    !exactKeys(step, ["rowId", "surface", "reason", "evidenceContract"]) ||
    step.reason !== scenario.expected ||
    !sameValues(step.evidenceContract, evidenceContract)
  ) {
    reject("coverage-content");
  }
}

function validateUninstallReinstallSection(scenarios, section) {
  if (
    !record(section) ||
    !sameValues(section.phaseOrder, uninstallPhaseOrder) ||
    !sameValues(section.phases, uninstallPhases) ||
    !Array.isArray(section.rowMappings) ||
    !Array.isArray(section.durableInventory) ||
    !sameValues(section.preservedDataRoots, preservedDataRoots) ||
    !sameValues(section.removedIntegrationState, removedIntegrationState) ||
    !sameValues(section.transientInventory, transientInventory) ||
    section.transientAssertion !== transientAssertion
  ) {
    reject("uninstall-protocol");
  }
  const expectedRows = scenarios
    .filter((scenario) => scenario.id.startsWith("uninstall."))
    .map((scenario) => scenario.id);
  const expectedIds = new Set(expectedRows);
  const mappedIds = new Set();
  for (const mapping of section.rowMappings) {
    if (
      !record(mapping) ||
      typeof mapping.rowId !== "string" ||
      !sameValues(mapping.phases, uninstallPhaseOrder)
    ) {
      reject("uninstall-protocol");
    }
    if (!expectedIds.has(mapping.rowId)) reject("uninstall-unknown");
    if (mappedIds.has(mapping.rowId)) reject("uninstall-duplicate");
    mappedIds.add(mapping.rowId);
  }
  if (expectedRows.some((rowId) => !mappedIds.has(rowId))) reject("uninstall-missing");
  const expectedDurableInventory = expectedRows
    .filter((rowId) => rowId.startsWith("uninstall.durable."))
    .map((rowId) => ({ rowId, durableClass: durableClassName(rowId) }));
  if (!sameValues(section.durableInventory, expectedDurableInventory)) {
    reject("uninstall-protocol");
  }
}

function validateLiveSmokeLane(lane) {
  if (
    !record(lane) ||
    lane.mode !== "live-smoke" ||
    lane.includedInDeterministicLane !== false ||
    !sameValues(lane.smokes, WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES) ||
    !sameValues(lane.outputPolicy, { secrets: "never", identifiers: "redacted" })
  ) {
    reject("live-smoke-separation");
  }
}

export function validateWindowsInstalledAcceptanceClosure(collection, plan) {
  validateScenarioSource(collection);
  if (
    !record(plan) ||
    plan.schemaVersion !== 1 ||
    plan.kind !== "windows-installed-acceptance-plan" ||
    !sameValues(plan.manifests, collection.manifests) ||
    !Array.isArray(plan.automatedEvidence) ||
    !Array.isArray(plan.manualChecklist)
  ) {
    reject("closure-shape");
  }
  const scenariosById = new Map(collection.scenarios.map((scenario) => [scenario.id, scenario]));
  const coverage = [
    ...plan.automatedEvidence.map((step) => ({ step, automation: "deterministic" })),
    ...plan.manualChecklist.map((step) => ({ step, automation: "vm-only" })),
  ];
  const coveredIds = new Set();
  for (const entry of coverage) {
    if (!record(entry.step) || typeof entry.step.rowId !== "string") reject("coverage-shape");
    if (coveredIds.has(entry.step.rowId)) reject("coverage-duplicate");
    const scenario = scenariosById.get(entry.step.rowId);
    if (scenario === undefined) reject("coverage-unknown");
    coveredIds.add(entry.step.rowId);
    validateCoverageStep(entry.step, scenario, entry.automation);
  }
  if (collection.scenarios.some((scenario) => !coveredIds.has(scenario.id))) {
    reject("coverage-missing");
  }
  const totals = {
    total: collection.scenarios.length,
    deterministic: collection.scenarios.filter(
      (scenario) => scenario.automation === "deterministic",
    ).length,
    vmOnly: collection.scenarios.filter((scenario) => scenario.automation === "vm-only").length,
  };
  if (!sameValues(plan.totals, totals)) reject("totals");
  validateUninstallReinstallSection(collection.scenarios, plan.uninstallReinstall);
  validateLiveSmokeLane(plan.liveSmokeLane);
  return Object.freeze({ valid: true, totals: Object.freeze(totals) });
}

export function requireWindowsInstalledExecutionPlatform(
  platform = process.platform,
  architecture = process.arch,
) {
  if (platform !== "win32") reject("platform");
  if (architecture !== "x64") reject("architecture");
}

function requireChecklistResult(value, stage = "result") {
  if (!checklistResults.includes(value)) reject(stage);
  return value;
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requireSafeEvidence(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    hasControlCharacters(value) ||
    unsafeUnbrokenTokenRunPattern.test(value) ||
    /[\\/]/u.test(value) ||
    /\S+@\S+/u.test(value) ||
    /(?:^|\s)@[a-z0-9_]/iu.test(value) ||
    /\b(?:athlete|account|chat|user)\s+(?:id|identifier)\s*[:=]/iu.test(value) ||
    /\b(?:api[ -]?key|authorization|bearer|password|passphrase|secret|token)\s*[:=]/iu.test(
      value,
    ) ||
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(value)
  ) {
    reject("result-privacy");
  }
  return value;
}

function planExecutionEntries(plan) {
  if (
    !record(plan) ||
    !Array.isArray(plan.automatedEvidence) ||
    !Array.isArray(plan.manualChecklist)
  ) {
    reject("result-plan");
  }
  return [
    ...plan.automatedEvidence.map((step) => Object.freeze({ lane: "automated", step })),
    ...plan.manualChecklist.map((step) => Object.freeze({ lane: "manual", step })),
  ];
}

function summarizeResults(rows) {
  const totals = {
    total: rows.length,
    passed: rows.filter((row) => row.checklistResult === "pass").length,
    failed: rows.filter((row) => row.checklistResult === "fail").length,
    incomplete: rows.filter((row) => row.checklistResult === "incomplete").length,
  };
  const complete = totals.incomplete === 0;
  const passed = complete && totals.failed === 0;
  return Object.freeze({
    status: complete ? (passed ? "pass" : "fail") : "incomplete",
    complete,
    passed,
    totals: Object.freeze(totals),
  });
}

export function createWindowsInstalledAcceptanceResult(plan, outcomes = []) {
  if (!Array.isArray(outcomes)) reject("result-shape");
  const entries = planExecutionEntries(plan);
  const expectedIds = new Set(entries.map((entry) => entry.step.rowId));
  const supplied = new Map();
  for (const outcome of outcomes) {
    if (
      !record(outcome) ||
      !exactKeys(outcome, ["rowId", "checklistResult", "evidence"]) ||
      typeof outcome.rowId !== "string" ||
      !expectedIds.has(outcome.rowId)
    ) {
      reject("result-shape");
    }
    if (supplied.has(outcome.rowId)) reject("result-duplicate");
    supplied.set(
      outcome.rowId,
      Object.freeze({
        checklistResult: requireChecklistResult(outcome.checklistResult),
        evidence: requireSafeEvidence(outcome.evidence),
      }),
    );
  }
  const rows = Object.freeze(
    entries.map((entry) => {
      const outcome = supplied.get(entry.step.rowId) ?? {
        checklistResult: "incomplete",
        evidence: "",
      };
      return Object.freeze({
        rowId: entry.step.rowId,
        lane: entry.lane,
        checklistResult: outcome.checklistResult,
        evidence: outcome.evidence,
      });
    }),
  );
  const summary = summarizeResults(rows);
  return Object.freeze({
    schemaVersion: 1,
    kind: resultKinds.installed,
    status: summary.status,
    complete: summary.complete,
    passed: summary.passed,
    totals: summary.totals,
    rows,
  });
}

export function validateWindowsInstalledAcceptanceResult(plan, artifact) {
  if (
    !record(artifact) ||
    !Array.isArray(artifact.rows) ||
    artifact.kind !== resultKinds.installed
  ) {
    reject("result-shape");
  }
  const outcomes = artifact.rows.map((row) => {
    if (!record(row)) reject("result-shape");
    return {
      rowId: row.rowId,
      checklistResult: row.checklistResult,
      evidence: row.evidence,
    };
  });
  const canonical = createWindowsInstalledAcceptanceResult(plan, outcomes);
  if (!sameValues(artifact, canonical)) reject("result-integrity");
  return canonical;
}

function createWindowsInstalledLiveSmokeResult(outcomes = []) {
  if (!Array.isArray(outcomes)) reject("live-smoke-result");
  const expectedIds = new Set(WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES.map((smoke) => smoke.id));
  const supplied = new Map();
  for (const outcome of outcomes) {
    if (
      !record(outcome) ||
      typeof outcome.smokeId !== "string" ||
      !expectedIds.has(outcome.smokeId) ||
      typeof outcome.evidence !== "string"
    ) {
      reject("live-smoke-result");
    }
    if (supplied.has(outcome.smokeId)) reject("live-smoke-result");
    supplied.set(outcome.smokeId, {
      checklistResult: requireChecklistResult(outcome.checklistResult, "live-smoke-result"),
      evidence: outcome.evidence.length === 0 ? "" : "Evidence recorded and redacted.",
    });
  }
  const rows = Object.freeze(
    WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES.map((smoke) => {
      const outcome = supplied.get(smoke.id) ?? {
        checklistResult: "incomplete",
        evidence: "",
      };
      return Object.freeze({
        smokeId: smoke.id,
        checklistResult: outcome.checklistResult,
        evidence: outcome.evidence,
      });
    }),
  );
  const summary = summarizeResults(rows);
  return Object.freeze({
    schemaVersion: 1,
    kind: resultKinds.liveSmoke,
    status: summary.status,
    complete: summary.complete,
    passed: summary.passed,
    totals: summary.totals,
    rows,
  });
}

export async function executeWindowsInstalledAcceptance(input = {}, dependencies = {}) {
  requireWindowsInstalledExecutionPlatform(
    dependencies.platform ?? process.platform,
    dependencies.architecture ?? process.arch,
  );
  const plan = input.plan ?? (await buildWindowsInstalledAcceptancePlan());
  const collectOutcome = dependencies.collectOutcome;
  const outcomes = [];
  if (collectOutcome !== undefined) {
    for (const entry of planExecutionEntries(plan)) {
      const outcome = await collectOutcome(entry);
      outcomes.push({ rowId: entry.step.rowId, ...outcome });
    }
  }
  return createWindowsInstalledAcceptanceResult(plan, outcomes);
}

export async function executeWindowsInstalledLiveSmokes(dependencies = {}) {
  requireWindowsInstalledExecutionPlatform(
    dependencies.platform ?? process.platform,
    dependencies.architecture ?? process.arch,
  );
  const collectOutcome = dependencies.collectOutcome;
  const outcomes = [];
  if (collectOutcome !== undefined) {
    for (const smoke of WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES) {
      const outcome = await collectOutcome(smoke);
      outcomes.push({ smokeId: smoke.id, ...outcome });
    }
  }
  return createWindowsInstalledLiveSmokeResult(outcomes);
}

async function collectCliOutcome(lines, title, detail) {
  process.stderr.write(`${title}\n${detail}\n`);
  let checklistResult;
  while (checklistResult === undefined) {
    const candidate = (await lines.question("Checklist result (pass, fail, incomplete): ")).trim();
    if (checklistResults.includes(candidate)) checklistResult = candidate;
  }
  let evidence;
  while (evidence === undefined) {
    const candidate = (
      await lines.question("Path-free, credential-free evidence (free text, may be empty): ")
    ).trim();
    try {
      evidence = requireSafeEvidence(candidate);
    } catch {
      process.stderr.write("Evidence refused at result-privacy.\n");
    }
  }
  return { checklistResult, evidence };
}

async function readJsonFromStandardInput() {
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  try {
    return JSON.parse(source);
  } catch {
    reject("validation-input");
  }
}

async function main() {
  if (process.argv.length !== 3) reject("mode");
  const mode = process.argv[2];
  if (mode === "plan") {
    process.stdout.write(`${JSON.stringify(await buildWindowsInstalledAcceptancePlan())}\n`);
    return;
  }
  if (mode === "closure") {
    const collection = await loadWindowsParityScenarios();
    const plan = createWindowsInstalledAcceptancePlan(collection);
    process.stdout.write(
      `${JSON.stringify(validateWindowsInstalledAcceptanceClosure(collection, plan))}\n`,
    );
    return;
  }
  if (mode === "validate") {
    const plan = await buildWindowsInstalledAcceptancePlan();
    const result = validateWindowsInstalledAcceptanceResult(
      plan,
      await readJsonFromStandardInput(),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === "execute") {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const result = await executeWindowsInstalledAcceptance(
        {},
        {
          collectOutcome(entry) {
            const detail =
              entry.lane === "automated"
                ? `${entry.step.expected}\n${entry.step.tests.join("\n")}`
                : entry.step.reason;
            return collectCliOutcome(
              lines,
              `${entry.lane.toUpperCase()} ${entry.step.rowId}`,
              detail,
            );
          },
        },
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      lines.close();
    }
    return;
  }
  if (mode === "live-smoke") {
    const lines = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const result = await executeWindowsInstalledLiveSmokes({
        collectOutcome(smoke) {
          return collectCliOutcome(lines, `LIVE SMOKE ${smoke.name}`, smoke.check);
        },
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      lines.close();
    }
    return;
  }
  reject("mode");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const stage = error instanceof WindowsInstalledAcceptanceError ? error.stage : "execution";
    process.stderr.write(`windows-installed acceptance refused at ${stage}\n`);
    process.exitCode = 1;
  }
}
