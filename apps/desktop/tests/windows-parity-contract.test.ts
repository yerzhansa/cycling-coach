import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWindowsParityScenarios } from "../scripts/windows-parity-scenarios.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const requiredAutomation = [
  "daemon.supervision.crash-restart",
  "storage.windows.durable-writes",
  "settings.providers.chatgpt-refusals",
  "training.import.progress-results",
  "training.export.cancellation-failures",
  "telegram.lifecycle.conflict-rejection",
  "telegram.power.sleep-wake",
  "telegram.power.delivery-gap",
  "updater.unsigned.package-truth",
  "shell.single-instance.activation",
  "shell.tray.window-residency",
  "daemon.shutdown.quit-drain",
  "telegram.storage.encrypted-profile",
] as const;

const requiredVmProofs = [
  "updater.windows.unsigned-ui",
  "shell.windows.second-launch",
  "uninstall.durable.desktop-credentials",
] as const;

describe("Windows parity automation contract", () => {
  it("binds the required fault lanes to deterministic scenarios", async () => {
    const collection = await loadWindowsParityScenarios();
    const scenarios = new Map(collection.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const id of requiredAutomation) expect(scenarios.get(id)?.automation, id).toBe("deterministic");
  });

  it("keeps Windows-host-only proofs explicit", async () => {
    const collection = await loadWindowsParityScenarios();
    const scenarios = new Map(collection.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const id of requiredVmProofs) expect(scenarios.get(id)?.automation, id).toBe("vm-only");
  });

  it("builds once and invokes one hosted installed driver without 7-Zip", async () => {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const driver = await readFile(
      join(repositoryRoot, "apps/desktop/scripts/windows-installed-package.mjs"),
      "utf8",
    );
    const nativeEvidence = await readFile(
      join(repositoryRoot, "apps/desktop/scripts/windows-installed-evidence.ps1"),
      "utf8",
    );
    const packageCommands = workflow.match(/pnpm --filter @enduragent\/desktop package:win/g) ?? [];
    const installedCommands = workflow.match(
      /pnpm --filter @enduragent\/desktop test:windows-installed-self-test -- --github-hosted --signature-policy unsigned-private/g,
    ) ?? [];
    expect(packageCommands).toHaveLength(1);
    expect(installedCommands).toHaveLength(1);
    expect(workflow.indexOf(packageCommands[0]!)).toBeLessThan(workflow.indexOf(installedCommands[0]!));
    expect(workflow).not.toMatch(/7-zip|7z\.exe|verify:win-package|test:windows-packaged-self-test/iu);
    expect(workflow).toContain("timeout-minutes: 45");
    expect(manifest.scripts["test:windows-installed-self-test"]).toBe(
      "node scripts/verify-windows-installed-self-test.mjs",
    );
    expect(driver.match(/dependencies\.verifyWindowsPackage \?\? verifyWindowsPackage/gu)).toHaveLength(
      1,
    );
    expect(driver).toContain('await run(installer, ["/S"]');
    expect(driver).toContain("installed.quietArgs");
    expect(driver).toContain("new AggregateError");
    expect(driver).toContain('child.once("close"');
    expect(nativeEvidence).toContain("ConvertFrom-Json");
    expect(nativeEvidence).toContain("Get-AuthenticodeSignature");
    expect(nativeEvidence).toContain("WScript.Shell");
    expect(nativeEvidence).toContain("Get-CimInstance Win32_Process -Filter");
    expect(nativeEvidence).not.toContain("[IO.Path]::GetFileName");
    expect(nativeEvidence).not.toContain("Invoke-Expression");
  });
});
