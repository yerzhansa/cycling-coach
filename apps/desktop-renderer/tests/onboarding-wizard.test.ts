import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ADVANCED_MODEL_CREDENTIAL_SLOTS,
  INTERVALS_GUIDANCE,
  ONBOARDING_STEP_IDS,
  PRIMARY_MODEL_CREDENTIAL_SLOTS,
} from "../src/onboarding/constants.js";
import {
  createOnboardingBridge,
  validateImportPaths,
  type DesktopOnboardingAuth,
} from "../src/onboarding/bridge.js";

describe("desktop onboarding wizard", () => {
  it("pins the ratified steps, provider catalogue, and intervals guidance", () => {
    expect(ONBOARDING_STEP_IDS).toEqual(["coach-keys", "training-data", "safety-intake", "ready"]);
    expect(PRIMARY_MODEL_CREDENTIAL_SLOTS).toEqual([
      { id: "anthropic", label: "Anthropic API key", hint: "Recommended" },
      { id: "openrouter", label: "OpenRouter API key", hint: "Everything else" },
    ]);
    expect(ADVANCED_MODEL_CREDENTIAL_SLOTS.map(({ id }) => id)).toEqual([
      "openai",
      "google",
      "deepseek",
      "qwen",
      "minimax",
      "kimi",
      "zai",
    ]);
    expect(INTERVALS_GUIDANCE).toBe(
      "Connect your device platform to intervals.icu directly, not via Strava.",
    );
  });

  it("enforces absolute unique FIT, TCX, and GPX selections before dispatch", () => {
    expect(
      validateImportPaths(["/synthetic/a.FIT", "/synthetic/b.tcx", "/synthetic/c.GpX"]),
    ).toEqual(["/synthetic/a.FIT", "/synthetic/b.tcx", "/synthetic/c.GpX"]);
    expect(() => validateImportPaths(["relative.fit"])).toThrow(TypeError);
    expect(() => validateImportPaths(["/synthetic/a.zip"])).toThrow(TypeError);
    expect(() => validateImportPaths(["/synthetic/a.fit", "/synthetic/a.fit"])).toThrow();
    expect(() =>
      validateImportPaths(Array.from({ length: 257 }, (_, index) => `/synthetic/${index}.fit`)),
    ).toThrow();
    expect(() => validateImportPaths([`/synthetic/${"a".repeat(4_090)}.fit`])).toThrow();
  });

  it("uses the authenticated client for exact import and intake methods", async () => {
    const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
    const client = {
      handshake: {},
      async call(
        method: string,
        request: unknown,
        options?: { onNotificationEnvelope?: (value: unknown) => void },
      ) {
        calls.push({ method, request });
        if (method === "importFiles") {
          options?.onNotificationEnvelope?.({
            jsonrpc: "2.0",
            method: "coach.operationProgress",
            params: {
              requestId: 1,
              requestMethod: "importFiles",
              event: { phase: "started", completed: 0, total: 1 },
            },
          });
          return {
            schemaVersion: 2,
            files: { total: 1, imported: 1, quarantined: 0 },
            changes: {
              rawFilesInserted: 1,
              sourceRecordsInserted: 1,
              sourceRecordsUpdated: 0,
              relinkedSourceRecords: 0,
            },
            publication: { scope: "activities-and-streams", status: "available" },
          };
        }
        return { schemaVersion: 1, saved: true };
      },
      close: vi.fn(),
    };
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc" as const,
        rendererCapability: "s".repeat(43),
        generation: 1,
      })),
      credentialStatuses: vi.fn(async () => []),
      retryFailedCredentials: vi.fn(async () => [
        {
          slot: "anthropic" as const,
          state: "configured" as const,
          runtimeState: "active" as const,
        },
      ]),
      writeCredential: vi.fn(),
      chooseImportFiles: vi.fn(async () => []),
      onDroppedImportFiles: vi.fn(() => vi.fn()),
    } as unknown as DesktopOnboardingAuth;
    const connect = vi.fn(async () => client as never);
    const bridge = createOnboardingBridge(auth, connect);
    const progress = vi.fn();
    await bridge.importFiles(["/synthetic/ride.fit"], progress);
    await bridge.saveIntake({
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    });
    expect(calls).toEqual([
      { method: "importFiles", request: { paths: ["/synthetic/ride.fit"] } },
      {
        method: "saveIntake",
        request: {
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
        },
      },
    ]);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:45001/rpc",
      token: "s".repeat(43),
    });
  });

  it("passes ChatGPT status and login through without connecting the daemon", async () => {
    const auth = {
      getDaemonConnection: vi.fn(),
      credentialStatuses: vi.fn(async () => []),
      retryFailedCredentials: vi.fn(async () => [
        {
          slot: "anthropic" as const,
          state: "configured" as const,
          runtimeState: "active" as const,
        },
      ]),
      writeCredential: vi.fn(),
      chatgptStatus: vi.fn(async () => ({ state: "configured" as const, runtimeReady: false })),
      chatgptLogin: vi.fn(async () => ({
        status: "configured" as const,
        runtimeReady: true as const,
      })),
      chooseImportFiles: vi.fn(async () => []),
      onDroppedImportFiles: vi.fn(() => vi.fn()),
    } as unknown as DesktopOnboardingAuth;
    const connect = vi.fn();
    const bridge = createOnboardingBridge(auth, connect);
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.5",
      endpoint: { mode: "automatic" as const },
    };
    await expect(bridge.chatGptStatus()).resolves.toEqual({
      state: "configured",
      runtimeReady: false,
    });
    await expect(bridge.chatGptLogin(selection)).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(auth.chatgptLogin).toHaveBeenCalledWith(selection);
    await expect(bridge.retryFailedCredentials()).resolves.toEqual([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("retries connection resolution after a transient connection failure", async () => {
    const connection = {
      url: "ws://127.0.0.1:45001/rpc" as const,
      rendererCapability: "s".repeat(43),
      generation: 1,
    };
    const getDaemonConnection = vi
      .fn<DesktopOnboardingAuth["getDaemonConnection"]>()
      .mockRejectedValueOnce(new TypeError())
      .mockResolvedValue(connection);
    const auth = {
      getDaemonConnection,
      credentialStatuses: vi.fn(async () => []),
      writeCredential: vi.fn(),
      chooseImportFiles: vi.fn(async () => []),
      onDroppedImportFiles: vi.fn(() => vi.fn()),
    } as unknown as DesktopOnboardingAuth;
    const client = {
      handshake: {},
      call: vi.fn(async () => ({
        schemaVersion: 2,
        files: { total: 1, imported: 1, quarantined: 0 },
        changes: {
          rawFilesInserted: 1,
          sourceRecordsInserted: 1,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
        publication: { scope: "activities-and-streams", status: "available" },
      })),
      close: vi.fn(),
    };
    const connect = vi.fn(async () => client as never);
    const bridge = createOnboardingBridge(auth, connect);
    await expect(bridge.importFiles(["/synthetic/ride.fit"], vi.fn())).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(bridge.importFiles(["/synthetic/ride.fit"], vi.fn())).resolves.toMatchObject({
      files: { imported: 1 },
    });
    expect(getDaemonConnection).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("ships the setup page and responsive accessibility hooks", async () => {
    const [wizard, coachKeys, styles] = await Promise.all([
      readFile(new URL("../src/ui/onboarding/OnboardingWizard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/onboarding/CoachKeysStep.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("../src/ui/onboarding/OnboardingWizard.module.css", import.meta.url),
        "utf8",
      ),
    ]);
    expect(wizard).toContain("<Page");
    expect(wizard).toContain('title="Setup"');
    expect(wizard).toContain('className="onboarding"');
    expect(wizard).not.toContain('role="dialog"');
    expect(wizard).not.toContain('aria-modal="true"');
    expect(wizard).not.toContain('event.key === "Escape"');
    expect(wizard).not.toContain('event.key !== "Tab"');
    expect(wizard).toContain('aria-live="polite"');
    expect(coachKeys).toContain("Sign in with ChatGPT");
    expect(coachKeys).toContain("Requires a paid ChatGPT plan. No API key needed.");
    expect(coachKeys).toContain("Finish signing in in your browser…");
    expect(styles).not.toContain("border-radius: 22px");
    expect(styles).not.toContain("width: min(680px");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).not.toContain("backdrop-filter");
  });
});
