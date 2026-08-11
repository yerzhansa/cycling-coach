import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WINDOWS_PARITY_SCENARIO_MANIFESTS,
  loadWindowsParityScenarios,
  WINDOWS_PARITY_SCENARIO_MANIFEST_MAX_BYTES,
  WindowsParityScenarioManifestError,
  type WindowsParityScenarioManifestStage,
} from "../scripts/windows-parity-scenarios.mjs";

function deterministic(id = "chat.synthetic") {
  return {
    id,
    surface: "chat",
    expected: "The synthetic behavior remains available.",
    automation: "deterministic",
    test: "apps/desktop/tests/synthetic.test.ts > proves the synthetic behavior",
  } as const;
}

function deterministicWithTests(id = "chat.multi-citation") {
  return {
    id,
    surface: "chat",
    expected: "The synthetic behavior has multiple independent proofs.",
    automation: "deterministic",
    tests: [
      "apps/desktop/tests/synthetic.test.ts > proves the first behavior",
      "apps/desktop-renderer/tests/synthetic.test.tsx > proves the second behavior",
    ],
  } as const;
}

function manifest(scenarios: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, scenarios, ...extra });
}

function reader(files: Readonly<Record<string, string>>) {
  return vi.fn(async (path: string, encoding: "utf8") => {
    expect(encoding).toBe("utf8");
    const source = files[basename(path)];
    if (source === undefined) {
      const error = new Error("private missing path") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return source;
  });
}

async function expectStage(
  operation: Promise<unknown>,
  stage: WindowsParityScenarioManifestStage,
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "WindowsParityScenarioManifestError",
    message: `windows-parity scenario manifest rejected at ${stage}`,
    stage,
  });
  await expect(operation).rejects.not.toThrow("private");
}

describe("Windows parity scenario manifests", () => {
  it("loads the frozen Chat, Settings, Training and Telegram manifests with tested deterministic rows", async () => {
    const collection = await loadWindowsParityScenarios();

    expect(collection.schemaVersion).toBe(1);
    expect(collection.manifests).toEqual(DEFAULT_WINDOWS_PARITY_SCENARIO_MANIFESTS);
    expect({
      total: collection.scenarios.length,
      deterministic: collection.scenarios.filter(
        (scenario) => scenario.automation === "deterministic",
      ).length,
      vmOnly: collection.scenarios.filter((scenario) => scenario.automation === "vm-only").length,
    }).toEqual({ total: 100, deterministic: 89, vmOnly: 11 });
    expect(new Set(collection.scenarios.map((scenario) => scenario.id)).size).toBe(
      collection.scenarios.length,
    );
    for (const scenario of collection.scenarios) {
      expect(scenario.expected).not.toBe("");
      if (scenario.automation === "deterministic") {
        const citations = "test" in scenario ? [scenario.test] : scenario.tests;
        expect(citations.length).toBeGreaterThan(0);
        for (const citation of citations) {
          const [testPath, ...testSegments] = citation.split(" > ");
          const testName = testSegments.at(-1);
          expect(testPath).toMatch(/^(?:apps|packages)\//u);
          expect(testName).toBeTruthy();
          expect(await readFile(testPath!, "utf8")).toContain(JSON.stringify(testName));
        }
        if ("tests" in scenario) expect(Object.isFrozen(scenario.tests)).toBe(true);
      } else {
        expect(scenario).not.toHaveProperty("test");
        expect(scenario).not.toHaveProperty("tests");
      }
    }
    expect(
      collection.scenarios.flatMap((scenario) =>
        scenario.automation === "deterministic" && "tests" in scenario ? [scenario.id] : [],
      ),
    ).toEqual([
      "settings.providers.chatgpt-sign-in",
      "settings.providers.chatgpt-refusals",
      "settings.providers.claude-readiness",
      "training.setup.intervals-clipboard-connect",
      "training.setup.intervals-verification",
      "training.setup.intervals-delete-only",
      "training.setup.readiness-sources",
      "training.setup.readiness-recovery",
      "training.setup.file-import-fallback",
      "training.first-sync.provider-backfill",
      "training.first-sync.file-only",
      "training.first-sync.failure-recovery",
      "training.import.picker",
      "training.import.drop-routing",
      "training.import.progress-results",
      "training.view.panel-inventory",
      "training.view.readiness-states",
      "training.view.context-recovery",
      "training.ride-review.navigation",
      "training.ride-review.local-analysis",
      "training.ride-review.analysis-recovery",
      "training.view.anchor-load-plan-adherence",
      "training.export.activity-formats",
      "training.export.workout-formats",
      "training.export.cancellation-failures",
      "training.sync.lifecycle",
      "training.sync.retryable-recovery",
      "training.sync.protocol-failure",
      "training.ride-review.temporary-failure",
      "training.sidebar.sync-chip",
      "telegram.setup.clipboard-connect",
      "telegram.setup.refusal-recovery",
      "telegram.connection.delete-only",
      "telegram.pairing.webhook-removal",
      "telegram.pairing.primary-user",
      "telegram.allowed-senders.management",
      "telegram.allowed-senders.recovery",
      "telegram.status.redacted-projection",
      "telegram.lifecycle.daemon-binding",
      "telegram.lifecycle.turn-off-on",
      "telegram.lifecycle.conflict-rejection",
      "telegram.power.sleep-wake",
      "telegram.power.delivery-gap",
      "telegram.storage.encrypted-profile",
      "telegram.storage.failure-truth",
      "telegram.storage.diagnostics",
      "telegram.tray.status-projection",
      "telegram.release-chain.shutdown-drain",
    ]);
    expect(Object.isFrozen(collection)).toBe(true);
    expect(Object.isFrozen(collection.manifests)).toBe(true);
    expect(Object.isFrozen(collection.scenarios)).toBe(true);
    expect(collection.scenarios.every(Object.isFrozen)).toBe(true);
  });

  it("loads exact multiple deterministic citations and freezes nested evidence", async () => {
    const collection = await loadWindowsParityScenarios(
      {
        directory: "/synthetic/windows-parity",
        manifestNames: ["chat-settings.scenarios.json"],
      },
      {
        readFile: reader({
          "chat-settings.scenarios.json": manifest([deterministicWithTests()]),
        }),
      },
    );

    expect(collection.scenarios).toEqual([deterministicWithTests()]);
    const [scenario] = collection.scenarios;
    if (scenario?.automation !== "deterministic" || !("tests" in scenario)) {
      throw new TypeError("multiple citation shape missing");
    }
    expect(Object.isFrozen(scenario.tests)).toBe(true);
  });

  it("registers future Training and Telegram manifests without changing the loader contract", async () => {
    const readFile = reader({
      "chat-settings.scenarios.json": manifest([deterministic()]),
      "training.scenarios.json": manifest([
        {
          id: "training.synthetic",
          surface: "training",
          expected: "The synthetic training behavior remains available.",
          automation: "vm-only",
        },
      ]),
      "telegram.scenarios.json": manifest([deterministic("telegram.synthetic")]),
    });

    const collection = await loadWindowsParityScenarios(
      {
        directory: "/synthetic/windows-parity",
        manifestNames: [
          "chat-settings.scenarios.json",
          "training.scenarios.json",
          "telegram.scenarios.json",
        ],
      },
      { readFile },
    );

    expect(collection.manifests).toEqual([
      "chat-settings.scenarios.json",
      "training.scenarios.json",
      "telegram.scenarios.json",
    ]);
    expect(collection.scenarios.map((scenario) => scenario.id)).toEqual([
      "chat.synthetic",
      "training.synthetic",
      "telegram.synthetic",
    ]);
    expect(readFile).toHaveBeenCalledTimes(3);
  });

  it.each([
    { manifestNames: [] },
    { manifestNames: ["chat-settings.scenarios.json", "chat-settings.scenarios.json"] },
    { manifestNames: ["../chat-settings.scenarios.json"] },
    { manifestNames: ["training.json"] },
    { directory: "relative/windows-parity" },
  ])("rejects malformed loader configuration %#", async (input) => {
    await expectStage(loadWindowsParityScenarios(input), "configuration");
  });

  it("fails closed when any configured manifest is missing", async () => {
    const operation = loadWindowsParityScenarios(
      {
        directory: "/synthetic/windows-parity",
        manifestNames: ["chat-settings.scenarios.json", "training.scenarios.json"],
      },
      { readFile: reader({ "chat-settings.scenarios.json": manifest([deterministic()]) }) },
    );

    await expectStage(operation, "read");
  });

  it("rejects malformed JSON without exposing parser or path details", async () => {
    const operation = loadWindowsParityScenarios(
      { directory: "/synthetic/windows-parity" },
      { readFile: reader({ "chat-settings.scenarios.json": "{private" }) },
    );

    await expectStage(operation, "parse");
  });

  it("rejects a manifest over the bounded byte budget before parsing", async () => {
    const operation = loadWindowsParityScenarios(
      { directory: "/synthetic/windows-parity" },
      {
        readFile: reader({
          "chat-settings.scenarios.json": "x".repeat(
            WINDOWS_PARITY_SCENARIO_MANIFEST_MAX_BYTES + 1,
          ),
        }),
      },
    );

    await expectStage(operation, "size");
  });

  it.each([
    JSON.stringify([]),
    JSON.stringify({ schemaVersion: 2, scenarios: [deterministic()] }),
    JSON.stringify({ schemaVersion: 1, scenarios: [] }),
    manifest([deterministic()], { unexpected: true }),
    manifest([{ ...deterministic(), unexpected: true }]),
    manifest([{ ...deterministic(), id: "Chat synthetic" }]),
    manifest([{ ...deterministic(), surface: "Chat settings" }]),
    manifest([{ ...deterministic(), expected: "" }]),
    manifest([{ ...deterministic(), automation: "manual" }]),
    manifest([{ ...deterministic(), test: ["apps/desktop/tests/synthetic.test.ts"] }]),
    manifest([{ ...deterministicWithTests(), test: deterministic().test }]),
    manifest([{ ...deterministicWithTests(), tests: [] }]),
    manifest([{ ...deterministicWithTests(), tests: [""] }]),
    manifest([
      {
        ...deterministicWithTests(),
        tests: [deterministic().test, deterministic().test],
      },
    ]),
    manifest([
      {
        id: "chat.synthetic",
        surface: "chat",
        expected: "The synthetic behavior remains available.",
        automation: "deterministic",
      },
    ]),
    manifest([
      {
        id: "chat.synthetic",
        surface: "chat",
        expected: "The synthetic behavior remains available.",
        automation: "vm-only",
        test: "apps/desktop/tests/synthetic.test.ts > unexpected proof",
      },
    ]),
    manifest([
      {
        id: "chat.synthetic",
        surface: "chat",
        expected: "The synthetic behavior remains available.",
        automation: "vm-only",
        tests: ["apps/desktop/tests/synthetic.test.ts > unexpected proof"],
      },
    ]),
  ])("rejects malformed roots and rows %#", async (source) => {
    const operation = loadWindowsParityScenarios(
      { directory: "/synthetic/windows-parity" },
      { readFile: reader({ "chat-settings.scenarios.json": source }) },
    );

    await expectStage(operation, "schema");
  });

  it("rejects duplicate IDs inside one manifest and across the configured family", async () => {
    const within = loadWindowsParityScenarios(
      { directory: "/synthetic/windows-parity" },
      {
        readFile: reader({
          "chat-settings.scenarios.json": manifest([
            deterministic(),
            deterministic("chat.synthetic"),
          ]),
        }),
      },
    );
    await expectStage(within, "duplicate-id");

    const across = loadWindowsParityScenarios(
      {
        directory: "/synthetic/windows-parity",
        manifestNames: ["chat-settings.scenarios.json", "training.scenarios.json"],
      },
      {
        readFile: reader({
          "chat-settings.scenarios.json": manifest([deterministic()]),
          "training.scenarios.json": manifest([deterministic()]),
        }),
      },
    );
    await expectStage(across, "duplicate-id");
  });

  it("uses a stage-coded path-free error type", () => {
    const error = new WindowsParityScenarioManifestError("schema");

    expect(error).toEqual(
      expect.objectContaining({
        name: "WindowsParityScenarioManifestError",
        message: "windows-parity scenario manifest rejected at schema",
        stage: "schema",
      }),
    );
  });
});
