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
    for (const id of requiredAutomation)
      expect(scenarios.get(id)?.automation, id).toBe("deterministic");
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
    const installedCommands =
      workflow.match(
        /pnpm --filter @enduragent\/desktop test:windows-installed-self-test --github-hosted --signature-policy unsigned-private/g,
      ) ?? [];
    const windowsJob = workflow
      .split("  windows-desktop-package:")[1]
      ?.split(/\r?\n  desktop-integration-macos:/u)[0];
    expect(packageCommands).toHaveLength(1);
    expect(installedCommands).toHaveLength(1);
    expect(windowsJob).toContain(
      "pnpm exec vitest run apps/desktop/tests/windows-package-layout.test.ts apps/desktop/tests/windows-package-plan.test.ts apps/desktop/tests/windows-installed-package.test.ts apps/desktop/tests/windows-parity-contract.test.ts --maxWorkers=1",
    );
    expect(windowsJob).not.toContain("pnpm exec vitest run apps/desktop/tests ");
    expect(windowsJob).not.toContain("@enduragent/desktop-renderer test");
    expect(workflow.indexOf(packageCommands[0]!)).toBeLessThan(
      workflow.indexOf(installedCommands[0]!),
    );
    expect(workflow).not.toMatch(
      /7-zip|7z\.exe|verify:win-package|test:windows-packaged-self-test/iu,
    );
    expect(workflow).toContain("timeout-minutes: 45");
    expect(manifest.scripts["test:windows-installed-self-test"]).toBe(
      "node scripts/verify-windows-installed-self-test.mjs",
    );
    expect(
      driver.match(/dependencies\.verifyWindowsPackage \?\? verifyWindowsPackage/gu),
    ).toHaveLength(1);
    expect(driver).toContain('await run(installer, ["/S"]');
    expect(driver).toContain("installed.quietArgs");
    expect(driver).toContain("new AggregateError");
    expect(driver).toContain('child.once("close"');
    expect(driver).toContain('"pwsh.exe"');
    expect(driver).not.toContain('"powershell.exe"');
    expect(nativeEvidence).toContain("ConvertFrom-Json");
    expect(nativeEvidence).toContain("Get-AuthenticodeSignature");
    expect(nativeEvidence).toContain('$installRoot = "HKCU:\\Software\\$($Request.guid)"');
    expect(nativeEvidence).toContain(
      "[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    );
    expect(nativeEvidence).toContain('code = "NATIVE_EVIDENCE_FAILED"');
    expect(nativeEvidence).not.toContain("$_.Exception.Message");
    expect(nativeEvidence).toContain("[Collections.Generic.Stack[string]]::new()");
    expect(nativeEvidence).not.toMatch(/Get-ChildItem[^\r\n]*-Recurse/u);
    expect(nativeEvidence).toMatch(
      /if \(\(\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{\s+\$paths \+= \$item\.FullName\s+continue\s+\}\s+if \(-not \$item\.PSIsContainer\) \{ continue \}/u,
    );
    expect(nativeEvidence).toMatch(
      /if \(\(\$child\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{\s+\$paths \+= \$child\.FullName\s+\} elseif \(\$child\.PSIsContainer\) \{\s+\$pending\.Push\(\$child\.FullName\)\s+\}/u,
    );
    expect(nativeEvidence).toContain("installLocation = $installLocation");
    expect(nativeEvidence).toContain("WScript.Shell");
    expect(nativeEvidence).toContain("Get-CimInstance Win32_Process -Filter");
    expect(nativeEvidence).not.toContain("[IO.Path]::GetFileName");
    expect(nativeEvidence).not.toContain("Invoke-Expression");
  });
});
