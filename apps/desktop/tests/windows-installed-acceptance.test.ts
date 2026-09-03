import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES,
  buildWindowsInstalledAcceptancePlan,
  createWindowsInstalledAcceptancePlan,
  createWindowsInstalledAcceptanceResult,
  executeWindowsInstalledAcceptance,
  executeWindowsInstalledLiveSmokes,
  validateWindowsInstalledAcceptanceClosure,
  validateWindowsInstalledAcceptanceResult,
  type WindowsInstalledAcceptancePlan,
  type WindowsInstalledAcceptanceStage,
} from "../scripts/accept-windows-installed.mjs";
import {
  loadWindowsParityScenarios,
  type WindowsParityScenarioCollection,
} from "../scripts/windows-parity-scenarios.mjs";

function syntheticCollection(): WindowsParityScenarioCollection {
  return {
    schemaVersion: 1,
    manifests: ["synthetic.scenarios.json"],
    scenarios: [
      {
        id: "shell.synthetic.automated",
        surface: "shell",
        expected: "The synthetic automated behavior is proved.",
        automation: "deterministic",
        test: "apps/desktop/tests/synthetic.test.ts > proves automated behavior",
      },
      {
        id: "shell.synthetic.manual",
        surface: "shell",
        expected: "The synthetic installed behavior needs host observation.",
        automation: "vm-only",
      },
    ],
  };
}

function expectStage(operation: () => unknown, stage: WindowsInstalledAcceptanceStage): void {
  expect(operation).toThrowError(
    expect.objectContaining({
      name: "WindowsInstalledAcceptanceError",
      message: `windows-installed acceptance refused at ${stage}`,
      stage,
    }),
  );
}

describe("Windows installed acceptance", () => {
  it("builds exact closure over all real manifests with totals derived from their rows", async () => {
    const collection = await loadWindowsParityScenarios();
    const plan = await buildWindowsInstalledAcceptancePlan();
    const derivedTotals = {
      total: collection.scenarios.length,
      deterministic: collection.scenarios.filter(
        (scenario) => scenario.automation === "deterministic",
      ).length,
      vmOnly: collection.scenarios.filter((scenario) => scenario.automation === "vm-only").length,
    };

    expect(plan.manifests).toEqual(collection.manifests);
    expect(plan.totals).toEqual(derivedTotals);
    expect(plan.totals.total).toBe(138);
    expect(plan.automatedEvidence).toHaveLength(derivedTotals.deterministic);
    expect(plan.manualChecklist).toHaveLength(derivedTotals.vmOnly);
    expect(
      [
        ...plan.automatedEvidence.map((step) => step.rowId),
        ...plan.manualChecklist.map((item) => item.rowId),
      ].sort(),
    ).toEqual(collection.scenarios.map((scenario) => scenario.id).sort());
    expect(validateWindowsInstalledAcceptanceClosure(collection, plan)).toEqual({
      valid: true,
      totals: derivedTotals,
    });
    expect(
      plan.automatedEvidence.every((step) => step.tests.length > 0 && Object.isFrozen(step.tests)),
    ).toBe(true);
    expect(
      plan.manualChecklist.every(
        (item) =>
          item.reason.length > 0 &&
          item.evidenceContract.evidence.pathPolicy === "path-free" &&
          item.evidenceContract.evidence.credentialPolicy === "credential-free",
      ),
    ).toBe(true);
  });

  it("fails closed for unknown automation and duplicate, unknown, or missing row coverage", () => {
    const collection = syntheticCollection();
    const plan = createWindowsInstalledAcceptancePlan(collection);
    const unknownAutomation = {
      ...collection,
      scenarios: [
        {
          ...collection.scenarios[0],
          automation: "operator-only",
        },
      ],
    } as unknown as WindowsParityScenarioCollection;
    expectStage(() => createWindowsInstalledAcceptancePlan(unknownAutomation), "automation");

    const duplicate = {
      ...plan,
      automatedEvidence: [...plan.automatedEvidence, plan.automatedEvidence[0]],
    } as unknown as WindowsInstalledAcceptancePlan;
    expectStage(
      () => validateWindowsInstalledAcceptanceClosure(collection, duplicate),
      "coverage-duplicate",
    );

    const unknown = {
      ...plan,
      automatedEvidence: [
        {
          ...plan.automatedEvidence[0],
          rowId: "shell.synthetic.unknown",
        },
      ],
    } as unknown as WindowsInstalledAcceptancePlan;
    expectStage(
      () => validateWindowsInstalledAcceptanceClosure(collection, unknown),
      "coverage-unknown",
    );

    const missing = {
      ...plan,
      manualChecklist: [],
    } as unknown as WindowsInstalledAcceptancePlan;
    expectStage(
      () => validateWindowsInstalledAcceptanceClosure(collection, missing),
      "coverage-missing",
    );
  });

  it("maps every uninstall row through seed, uninstall, and reinstall inventory", async () => {
    const collection = await loadWindowsParityScenarios();
    const plan = createWindowsInstalledAcceptancePlan(collection);
    const uninstallRows = collection.scenarios
      .filter((scenario) => scenario.id.startsWith("uninstall."))
      .map((scenario) => scenario.id);
    const durableRows = uninstallRows.filter((rowId) => rowId.startsWith("uninstall.durable."));

    expect(plan.uninstallReinstall.phaseOrder).toEqual(["seed", "uninstall", "reinstall"]);
    expect(plan.uninstallReinstall.rowMappings.map((mapping) => mapping.rowId)).toEqual(
      uninstallRows,
    );
    expect(
      plan.uninstallReinstall.rowMappings.every((mapping) => Object.isFrozen(mapping.phases)),
    ).toBe(true);
    expect(plan.uninstallReinstall.rowMappings.map((mapping) => mapping.phases)).toEqual(
      uninstallRows.map(() => ["seed", "uninstall", "reinstall"]),
    );
    expect(plan.uninstallReinstall.durableInventory.map((item) => item.rowId)).toEqual(durableRows);
    expect(plan.uninstallReinstall.phases.map((phase) => phase.requirement).join(" ")).toMatch(
      /every durable class.*program and integration state.*both athlete-data and desktop user-data roots.*DPAPI secrets still decrypt/iu,
    );
    expect(plan.uninstallReinstall.transientInventory).toEqual([
      "updater cache and staging",
      "runtime locks",
      "daemon PID and port coordinates",
      "upgrade-fence claim coordinates",
      "crash temporaries",
    ]);
    expect(plan.uninstallReinstall.transientAssertion).toContain(
      "block same-user reinstall or a clean relaunch",
    );
  });

  it("keeps credential-safe live smokes out of the installed deterministic lane", async () => {
    const plan = createWindowsInstalledAcceptancePlan(syntheticCollection());
    const mainEntries: string[] = [];
    const mainResult = await executeWindowsInstalledAcceptance(
      { plan },
      {
        platform: "win32",
        architecture: "x64",
        collectOutcome(entry) {
          mainEntries.push(entry.step.rowId);
          return { checklistResult: "pass", evidence: "Synthetic check passed." };
        },
      },
    );

    expect(plan.liveSmokeLane.includedInDeterministicLane).toBe(false);
    expect(plan.liveSmokeLane.mode).toBe("live-smoke");
    expect(plan.liveSmokeLane.smokes.map((smoke) => smoke.name)).toEqual([
      "ChatGPT",
      "Claude CLI",
      "Intervals.icu",
      "Telegram",
      "One API-key provider",
    ]);
    expect(mainEntries).toEqual([
      ...plan.automatedEvidence.map((step) => step.rowId),
      ...plan.manualChecklist.map((item) => item.rowId),
    ]);
    expect(
      mainEntries.some((rowId) =>
        WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES.some((smoke) => smoke.id === rowId),
      ),
    ).toBe(false);
    expect(mainResult.kind).toBe("windows-installed-acceptance-result");

    const liveResult = await executeWindowsInstalledLiveSmokes({
      platform: "win32",
      architecture: "x64",
      collectOutcome() {
        return { checklistResult: "pass", evidence: "Sensitive identifiers observed." };
      },
    });
    expect(liveResult.rows.map((row) => row.smokeId)).toEqual(
      WINDOWS_INSTALLED_ACCEPTANCE_LIVE_SMOKES.map((smoke) => smoke.id),
    );
    expect(liveResult.rows.every((row) => row.evidence === "Evidence recorded and redacted.")).toBe(
      true,
    );
    expect(JSON.stringify(liveResult)).not.toContain("Sensitive identifiers observed.");
  });

  it("refuses execution off win32 before collecting evidence with a path-free stage", async () => {
    const collectOutcome = vi.fn();
    const operation = executeWindowsInstalledAcceptance(
      { plan: createWindowsInstalledAcceptancePlan(syntheticCollection()) },
      { platform: "darwin", architecture: "arm64", collectOutcome },
    );

    await expect(operation).rejects.toMatchObject({
      name: "WindowsInstalledAcceptanceError",
      message: "windows-installed acceptance refused at platform",
      stage: "platform",
    });
    await expect(operation).rejects.not.toThrow(/[\\/]/u);
    expect(collectOutcome).not.toHaveBeenCalled();
  });

  it("refuses live-smoke execution off win32 before collecting evidence", async () => {
    const collectOutcome = vi.fn();
    const operation = executeWindowsInstalledLiveSmokes({
      platform: "darwin",
      architecture: "arm64",
      collectOutcome,
    });

    await expect(operation).rejects.toMatchObject({
      name: "WindowsInstalledAcceptanceError",
      message: "windows-installed acceptance refused at platform",
      stage: "platform",
    });
    await expect(operation).rejects.not.toThrow(/[\\/]/u);
    expect(collectOutcome).not.toHaveBeenCalled();
  });

  it("accepts realistic prose evidence", () => {
    const plan = createWindowsInstalledAcceptancePlan(syntheticCollection());
    const [automated] = plan.automatedEvidence;
    const evidence =
      "Installed startup, settings persistence, and clean relaunch matched expectations.";
    const result = createWindowsInstalledAcceptanceResult(plan, [
      { rowId: automated.rowId, checklistResult: "pass", evidence },
    ]);

    expect(result.rows.find((row) => row.rowId === automated.rowId)?.evidence).toBe(evidence);
  });

  it("refuses a bare 40-character hexadecimal token at the evidence privacy stage", () => {
    const plan = createWindowsInstalledAcceptancePlan(syntheticCollection());
    const [automated] = plan.automatedEvidence;

    expectStage(
      () =>
        createWindowsInstalledAcceptanceResult(plan, [
          {
            rowId: automated.rowId,
            checklistResult: "pass",
            evidence: "0123456789abcdef0123456789abcdef01234567",
          },
        ]),
      "result-privacy",
    );
  });

  it("records missing outcomes as incomplete and never promotes them to pass", () => {
    const plan = createWindowsInstalledAcceptancePlan(syntheticCollection());
    const [automated] = plan.automatedEvidence;
    const [manual] = plan.manualChecklist;
    const incomplete = createWindowsInstalledAcceptanceResult(plan, [
      {
        rowId: automated.rowId,
        checklistResult: "pass",
        evidence: "Automated evidence passed.",
      },
    ]);

    expect(incomplete).toMatchObject({
      status: "incomplete",
      complete: false,
      passed: false,
      totals: { total: 2, passed: 1, failed: 0, incomplete: 1 },
    });
    expect(incomplete.rows.find((row) => row.rowId === manual.rowId)).toMatchObject({
      checklistResult: "incomplete",
      evidence: "",
    });
    expect(validateWindowsInstalledAcceptanceResult(plan, incomplete)).toEqual(incomplete);

    const dishonest = { ...incomplete, status: "pass", passed: true };
    expectStage(
      () => validateWindowsInstalledAcceptanceResult(plan, dishonest),
      "result-integrity",
    );

    const complete = createWindowsInstalledAcceptanceResult(
      plan,
      [automated.rowId, manual.rowId].map((rowId) => ({
        rowId,
        checklistResult: "pass" as const,
        evidence: "Acceptance evidence passed.",
      })),
    );
    expect(complete).toMatchObject({ status: "pass", complete: true, passed: true });
  });
});
