import { describe, expect, it, vi, type Mock } from "vitest";
import { KEYCHAIN_HELPER_RESOURCE_PATH } from "../scripts/package-inventory.mjs";
import {
  BACKEND_SELECTION_SERVICE,
  BACKEND_SELECTION_TEAM_IDENTIFIER,
  backendSelectionProbeRequest,
  safeMacosBackendSelectionMessage,
  verifyMacosBackendSelection,
} from "../scripts/verify-macos-backend-selection.mjs";

const application = "/synthetic/dist/mac-arm64/Enduragent.app";
const helper = `${application}/Contents/Resources/${KEYCHAIN_HELPER_RESOURCE_PATH}`;
const signedHelper = Object.freeze({
  teamIdentifier: "FA494ACVTF",
  designatedRequirement: 'identifier "keychain-helper" and anchor apple generic',
});

function probeAnswer(payload: unknown) {
  return vi.fn(async () => `${JSON.stringify(payload)}\n`);
}

interface HelperOverrides {
  readonly requireHelper: Mock;
  readonly verifyKeychainHelper: Mock;
  readonly runHelper: Mock;
}

function overrides(extra: Partial<HelperOverrides> = {}): HelperOverrides {
  return {
    requireHelper: vi.fn(async () => {}),
    verifyKeychainHelper: vi.fn(async () => signedHelper),
    runHelper: probeAnswer({
      ok: true,
      op: "probe",
      teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
    }),
    ...extra,
  };
}

describe("macOS backend selection verification", () => {
  it("probes the bundled helper only after its signature is verified", async () => {
    const dependencies = overrides();

    const verified = await verifyMacosBackendSelection(application, dependencies);

    expect(verified).toEqual({
      helper,
      service: BACKEND_SELECTION_SERVICE,
      teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
      designatedRequirement: signedHelper.designatedRequirement,
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(dependencies.requireHelper).toHaveBeenCalledWith(helper);
    expect(dependencies.verifyKeychainHelper).toHaveBeenCalledWith(application);
    expect(dependencies.runHelper).toHaveBeenCalledWith(helper, backendSelectionProbeRequest());
    expect(dependencies.requireHelper.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.verifyKeychainHelper.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.verifyKeychainHelper.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.runHelper.mock.invocationCallOrder[0]!,
    );
  });

  it("asks the helper for a read-only probe of the signed-release service", () => {
    expect(JSON.parse(backendSelectionProbeRequest())).toEqual({
      op: "probe",
      service: "icu.enduragent.desktop",
    });
    expect(backendSelectionProbeRequest().endsWith("\n")).toBe(true);
  });

  it("refuses a relative application path before touching the bundle", async () => {
    const dependencies = overrides();

    await expect(
      verifyMacosBackendSelection("dist/mac-arm64/Enduragent.app", dependencies),
    ).rejects.toThrow("application path must be absolute");
    expect(dependencies.requireHelper).not.toHaveBeenCalled();
  });

  it("stops when the bundled helper is absent", async () => {
    const dependencies = overrides({
      requireHelper: vi.fn(async () => {
        throw new Error("bundled keychain helper is missing");
      }),
    });

    await expect(verifyMacosBackendSelection(application, dependencies)).rejects.toThrow(
      "bundled keychain helper is missing",
    );
    expect(dependencies.verifyKeychainHelper).not.toHaveBeenCalled();
    expect(dependencies.runHelper).not.toHaveBeenCalled();
  });

  it("never probes a helper whose signature verification fails", async () => {
    const dependencies = overrides({
      verifyKeychainHelper: vi.fn(async () => {
        throw new Error("macOS keychain helper signing identity is invalid");
      }),
    });

    await expect(verifyMacosBackendSelection(application, dependencies)).rejects.toThrow(
      "macOS keychain helper signing identity is invalid",
    );
    expect(dependencies.runHelper).not.toHaveBeenCalled();
  });

  it("rejects a helper signed by another team", async () => {
    const dependencies = overrides({
      verifyKeychainHelper: vi.fn(async () => ({ ...signedHelper, teamIdentifier: "ZZZZZZZZZZ" })),
    });

    await expect(verifyMacosBackendSelection(application, dependencies)).rejects.toThrow(
      "bundled keychain helper signing identity is invalid",
    );
    expect(dependencies.runHelper).not.toHaveBeenCalled();
  });

  it("rejects a refused capability probe", async () => {
    const dependencies = overrides({
      runHelper: probeAnswer({ ok: false, code: "not-team-signed" }),
    });

    await expect(verifyMacosBackendSelection(application, dependencies)).rejects.toThrow(
      "bundled keychain helper refused the capability probe",
    );
  });

  it("rejects a probe answering another team identifier", async () => {
    const dependencies = overrides({
      runHelper: probeAnswer({ ok: true, op: "probe", teamIdentifier: "ZZZZZZZZZZ" }),
    });

    await expect(verifyMacosBackendSelection(application, dependencies)).rejects.toThrow(
      "bundled keychain helper reported an unexpected team identifier",
    );
  });

  it.each([
    ["", "bundled keychain helper answered nothing"],
    ["not json", "bundled keychain helper answered malformed JSON"],
    ["[]", "bundled keychain helper answered malformed JSON"],
    ['{"ok":true,"op":"read-key","key":"AA=="}', "bundled keychain helper refused the capability"],
  ])("rejects the probe answer %j", async (line, message) => {
    const dependencies = overrides({ runHelper: vi.fn(async () => line) });

    await expect(verifyMacosBackendSelection(application, dependencies)).rejects.toThrow(message);
  });

  it("names its own failures and stays silent about foreign errors", async () => {
    const dependencies = overrides({
      runHelper: probeAnswer({ ok: false, code: "keychain-locked" }),
    });
    const failure = await verifyMacosBackendSelection(application, dependencies).catch(
      (error: unknown) => error,
    );

    expect(safeMacosBackendSelectionMessage(failure)).toBe(
      "bundled keychain helper refused the capability probe",
    );
    expect(safeMacosBackendSelectionMessage(new Error("something else"))).toBeUndefined();
  });
});
