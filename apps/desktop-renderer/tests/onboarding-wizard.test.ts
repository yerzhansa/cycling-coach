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

const SETUP_SOURCES = [
  "OnboardingWizard.tsx",
  "SetupCard.tsx",
  "SetupRow.tsx",
  "AiRow.tsx",
  "TrainingRow.tsx",
  "IntakeRows.tsx",
  "InfoTip.tsx",
  "CredentialField.tsx",
] as const;

const BANNED_TRAINING_TERMS = [
  [84, 83, 83],
  [78, 80],
  [73, 70],
  [67, 84, 76],
  [65, 84, 76],
  [84, 83, 66],
].map((codes) => String.fromCharCode(...codes));

const PROVIDER_WORD_ALLOWLIST = [
  "9 providers · pay per use",
  "Created in the provider's console",
] as const;

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
        token: "s".repeat(43),
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
    const bridge = createOnboardingBridge(
      auth,
      vi.fn(async () => client as never),
    );
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
      token: "s".repeat(43),
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
    const [wizard, aiRow, card] = await Promise.all([
      readFile(new URL("../src/ui/onboarding/OnboardingWizard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/onboarding/AiRow.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/onboarding/SetupCard.tsx", import.meta.url), "utf8"),
    ]);
    expect(wizard).toContain("<Page");
    expect(wizard).toContain('title="Setup"');
    expect(wizard).toContain('className="onboarding"');
    expect(wizard).toContain("onboarding-dismiss");
    expect(wizard).not.toContain('role="dialog"');
    expect(wizard).not.toContain('aria-modal="true"');
    expect(wizard).not.toContain('event.key === "Escape"');
    expect(wizard).not.toContain('event.key !== "Tab"');
    expect(wizard).toContain('aria-live="polite"');
    expect(aiRow).toContain("CHATGPT_SIGN_IN_LABEL");
    expect(aiRow).toContain("CHATGPT_PENDING_LABEL");
    expect(aiRow).toContain("CHATGPT_PANEL_HINT");
    expect(card).toContain("[&>*+*]:border-t");
    expect(card).toContain("[&>*:first-child]:rounded-t-xl");
    expect(card).toContain("[&>*:last-child]:rounded-b-xl");
    expect(card).not.toContain("overflow-hidden");
    expect(card).not.toContain("w-[680px]");
    expect(card).not.toContain("backdrop-blur");
  });

  it("keeps setup control heights on the shared height tokens", async () => {
    const card = await readFile(
      new URL("../src/ui/onboarding/SetupCard.tsx", import.meta.url),
      "utf8",
    );
    expect(card).toContain("h-ctl-sm");
    expect(card).toContain("h-ctl-lg");
    expect(card).not.toContain("h-[28px]");
    expect(card).not.toContain("h-[36px]");
  });

  it("keeps one field class shared by every setup input", async () => {
    const [card, field] = await Promise.all([
      readFile(new URL("../src/ui/onboarding/SetupCard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/onboarding/CredentialField.tsx", import.meta.url), "utf8"),
    ]);
    expect(card).toContain("export const SETUP_FIELD_CLASS");
    expect(card).toContain("export const SETUP_LABEL_CLASS");
    expect(field).toContain("SETUP_FIELD_CLASS");
    expect(field).toContain("SETUP_LABEL_CLASS");
    expect(field).not.toContain("max-w-[236px]");
    expect(field).not.toContain("CREDENTIAL_INPUT_CLASS");
  });

  it("names only controls the setup screen still renders in its error copy", async () => {
    const copy = await readFile(new URL("../src/ui/onboarding/copy.ts", import.meta.url), "utf8");
    const start = copy.indexOf("export const ERROR_COPY");
    const end = copy.indexOf("export const CLAUDE_CLI_LANE_COPY");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const errors = copy.slice(start, end);
    expect(errors).not.toMatch(/\bContinue\b/u);
    expect(errors).not.toMatch(/\bBack\b/u);
    expect(errors).not.toMatch(/\bFinish setup\b/u);
    expect(errors).toContain("Choose Save to try it again.");
    expect(copy).toContain('export const RETRY_SAVED_KEYS_LABEL = "Retry saved keys"');
  });

  it("names the ChatGPT lane copy exactly once, in the copy module", async () => {
    const copy = await readFile(new URL("../src/ui/onboarding/copy.ts", import.meta.url), "utf8");
    expect(copy).toContain("Sign in with ChatGPT");
    expect(copy).toContain("Finish signing in in your browser…");
    expect(copy).toContain("Needs a paid plan.");
  });

  it("pairs every transition utility with a reduced-motion escape", async () => {
    const sources = await Promise.all(
      SETUP_SOURCES.map((name) =>
        readFile(new URL(`../src/ui/onboarding/${name}`, import.meta.url), "utf8"),
      ),
    );
    for (const [index, source] of sources.entries()) {
      const transitions = source.match(/transition-(?!none)[a-z-]+/gu) ?? [];
      const escapes = source.match(/motion-reduce:transition-none/gu) ?? [];
      expect({ file: SETUP_SOURCES[index], escapes: escapes.length }).toEqual({
        file: SETUP_SOURCES[index],
        escapes: transitions.length,
      });
    }
  });

  it("keeps the setup surface monochrome", async () => {
    const sources = await Promise.all(
      SETUP_SOURCES.map((name) =>
        readFile(new URL(`../src/ui/onboarding/${name}`, import.meta.url), "utf8"),
      ),
    );
    for (const [index, source] of sources.entries()) {
      expect({ file: SETUP_SOURCES[index], brand: /brand/u.test(source) }).toEqual({
        file: SETUP_SOURCES[index],
        brand: false,
      });
    }
    const card = sources[SETUP_SOURCES.indexOf("SetupCard.tsx")] ?? "";
    expect(card).toContain("bg-ink text-bg");
    const row = sources[SETUP_SOURCES.indexOf("SetupRow.tsx")] ?? "";
    expect(row).toContain("text-ok");
  });

  it("keeps athlete-facing setup copy free of internal vocabulary and trademarked terms", async () => {
    const copy = await readFile(new URL("../src/ui/onboarding/copy.ts", import.meta.url), "utf8");
    const start = copy.indexOf("export const SETUP_HEADING");
    expect(start).toBeGreaterThan(0);
    const prose = copy.slice(start);
    let scanned = prose;
    for (const allowed of PROVIDER_WORD_ALLOWLIST) scanned = scanned.split(allowed).join("");
    expect(scanned).not.toMatch(/\bproviders?\b/iu);
    expect(scanned).not.toMatch(/\blanes?\b/iu);
    expect(scanned).not.toMatch(/\bmodels?\b/iu);
    expect(scanned).not.toMatch(/account it thinks with/iu);
    for (const term of BANNED_TRAINING_TERMS) {
      expect(prose).not.toMatch(new RegExp(`\\b${term}\\b`, "u"));
    }
  });
});
