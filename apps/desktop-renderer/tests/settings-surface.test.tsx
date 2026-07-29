import type { CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot, SpendSummary } from "@enduragent/coach-contract";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import type {
  CredentialDeleteResult,
  OnboardingLlmConfiguration,
  OnboardingLlmSelection,
  OnboardingLlmSelectionResult,
} from "../src/onboarding/bridge.js";
import type { ChatGptStatus, CredentialSlotStatus } from "../src/onboarding/machine.js";
import { createReleaseNotesController } from "../src/release-notes/controller.js";
import { createAthleteSettingsController } from "../src/settings/athlete-controller.js";
import { createCredentialSettingsController } from "../src/settings/credential-controller.js";
import { createProviderModelSettingsController } from "../src/settings/provider-model-controller.js";
import { createSessionSettingsController } from "../src/settings/session-controller.js";
import { createSpendMeterController } from "../src/spend-meter/controller.js";
import { createReleaseNotesSettingsAdapter } from "../src/state/adapters/release-notes.js";
import {
  createAthleteSettingsAdapter,
  createCoachSettingsAdapter,
  createConversationSettingsAdapter,
  createCredentialSettingsAdapter,
} from "../src/state/adapters/settings.js";
import { createSpendSettingsAdapter } from "../src/state/adapters/spend.js";
import { createUpdateSettingsAdapter } from "../src/state/adapters/update.js";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import type { DesktopUpdateState } from "../src/update/controller.js";
import { createDesktopUpdateController } from "../src/update/controller.js";
import { SettingsView } from "../src/ui/settings/SettingsView.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(overrides: Partial<RuntimeConfigSnapshot> = {}): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: true },
    intervals: {
      athlete_id: "i1",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
    ...overrides,
  };
}

function llmConfiguration(): OnboardingLlmConfiguration {
  return {
    schemaVersion: 1,
    providers: [
      {
        provider: "anthropic",
        defaultModel: "synthetic-model",
        models: [
          { value: "synthetic-model", label: "Synthetic" },
          { value: "synthetic-fast", label: "Synthetic fast", hint: "cheap" },
        ],
      },
      {
        provider: "openrouter",
        defaultModel: "vendor/synthetic",
        models: [{ value: "vendor/synthetic", label: "Vendor synthetic" }],
      },
    ],
    active: { provider: "anthropic", model: "synthetic-model" },
  };
}

function spendSummary(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0.6,
    generationCount: 2,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 1,
    malformedLineCount: 0,
    spendComplete: false,
    capStatus: "reached",
    cacheReadTokens: 400,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: false,
    routes: [
      {
        provider: "openrouter",
        model: "anthropic/synthetic",
        generationCount: 2,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 1,
        providerReportedGenerationCount: 1,
        knownSpendUsd: 0.6,
        cacheReadTokens: 400,
        cacheReadSavingsUsd: null,
        caching: "unavailable",
        disclosure: "caching unavailable on this route",
      },
    ],
    ...overrides,
  } as SpendSummary;
}

interface HarnessOptions {
  readonly runtime?: () => RuntimeConfigSnapshot;
  readonly configureRuntime?: (params: unknown) => Promise<unknown>;
  readonly applyLlmSelection?: (
    selection: OnboardingLlmSelection,
  ) => Promise<OnboardingLlmSelectionResult>;
  readonly credentialStatuses?: readonly CredentialSlotStatus[];
  readonly chatGptStatus?: ChatGptStatus;
  readonly deleteCredential?: () => Promise<CredentialDeleteResult>;
  readonly releaseNotes?: () => Promise<ReleaseNotesResult>;
  readonly updateState?: DesktopUpdateState;
  readonly spend?: () => Promise<SpendSummary>;
}

function createHarness(options: HarnessOptions = {}) {
  const store = useEnduragentStore;
  const calls: { readonly method: string; readonly params: unknown }[] = [];
  const runtime = options.runtime ?? (() => snapshot());
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "getRuntimeConfig") return runtime();
      if (method === "configureRuntime") {
        return options.configureRuntime === undefined
          ? {
              schemaVersion: 3,
              status: "applied",
              applied: { llm: true, intervals: true, session: true },
            }
          : await options.configureRuntime(params);
      }
      if (method === "getSpendSummary") {
        return options.spend === undefined ? spendSummary() : await options.spend();
      }
      if (method === "setDailySpendCap") {
        const cap = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
        return spendSummary({ dailyCapUsd: cap, capStatus: "unknown" });
      }
      throw new TypeError(`unexpected rpc ${method}`);
    }),
  } as unknown as CoachClient;
  const clients: DesktopCoachClientProvider = {
    getClient: async () => client,
    reconnect: async () => client,
    close: async () => {},
  };

  const restartToUpdate = vi.fn(
    async (): Promise<DesktopUpdateState> => ({ status: "installing", version: "9.9.9" }),
  );
  const checkForUpdates = vi.fn(async (): Promise<DesktopUpdateState> => ({ status: "current" }));
  const applyLlmSelection = vi.fn(
    options.applyLlmSelection ??
      (async (): Promise<OnboardingLlmSelectionResult> => ({
        status: "configured",
        runtimeReady: true,
      })),
  );
  const deleteCredential = vi.fn(
    options.deleteCredential ??
      (async (): Promise<CredentialDeleteResult> => ({
        credential: "openrouter",
        status: "deleted",
        cleanupPending: false,
      })),
  );
  const openSetup = vi.fn();

  const coachAdapter = createCoachSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ coach: state }),
  });
  const credentialAdapter = createCredentialSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ credentials: state }),
  });
  const athleteAdapter = createAthleteSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ athlete: state }),
  });
  const conversationAdapter = createConversationSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ conversation: state }),
  });
  const spendAdapter = createSpendSettingsAdapter({
    read: () => store.getState().settings.spend,
    publish: (next) => store.getState().patchSettings({ spend: next }),
  });
  const updateAdapter = createUpdateSettingsAdapter({
    publish: (next) => store.getState().patchSettings({ update: next }),
  });
  const releaseNotesAdapter = createReleaseNotesSettingsAdapter({
    publish: (patch) => store.getState().patchSettings(patch),
  });

  const conversationController = createSessionSettingsController({
    clients,
    beginMutation: () => store.getState().beginSettingsMutation("session"),
    view: conversationAdapter.view,
  });
  const credentialController = createCredentialSettingsController({
    clients,
    loadStatuses: async () =>
      options.credentialStatuses ?? [
        { slot: "anthropic", state: "configured", runtimeState: "active" },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ],
    loadChatGptStatus: async () =>
      options.chatGptStatus ?? { state: "absent", runtimeReady: false },
    deleteCredential,
    openSetup,
    beginMutation: () => store.getState().beginSettingsMutation("credential"),
    view: credentialAdapter.view,
  });
  const athleteController = createAthleteSettingsController({
    clients,
    openSetup,
    beginMutation: () => store.getState().beginSettingsMutation("athlete"),
    view: athleteAdapter.view,
  });
  const coachController = createProviderModelSettingsController({
    load: async () => llmConfiguration(),
    apply: applyLlmSelection,
    openSetup,
    beginMutation: () => store.getState().beginSettingsMutation("provider-model"),
    view: coachAdapter.view,
  });
  const spendController = createSpendMeterController({
    clients,
    view: spendAdapter.view,
    setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as unknown as typeof globalThis.clearInterval,
  });
  const updateController = createDesktopUpdateController({
    bridge: {
      getUpdateState: async () => options.updateState ?? { status: "idle" },
      checkForUpdates,
      restartToUpdate,
      onUpdateState: () => () => {},
    },
    view: updateAdapter.view,
  });
  const releaseNotesController = createReleaseNotesController({
    request:
      options.releaseNotes ??
      (async () => ({
        status: "available",
        version: "1998.7.6",
        notes: ["Added a synthetic quick action."],
        releaseUrl: "https://example.invalid/release",
      })),
    view: releaseNotesAdapter.view,
  });

  store.getState().bindSettingsPorts({
    panes: {
      activate() {
        void coachController.activate();
        void credentialController.activate();
        void athleteController.activate();
        void conversationController.activate();
      },
      close() {
        coachController.close();
        credentialController.close();
        athleteController.close();
        conversationController.close();
      },
    },
    coach: coachAdapter.port,
    credentials: credentialAdapter.port,
    athlete: athleteAdapter.port,
    conversation: conversationAdapter.port,
    spend: spendAdapter.port,
    update: updateAdapter.port,
    releaseNotes: releaseNotesAdapter.port,
    units: { set: vi.fn() },
    openSetup,
  });

  return {
    calls,
    applyLlmSelection,
    deleteCredential,
    restartToUpdate,
    checkForUpdates,
    openSetup,
    spendController,
    startUpdate: () => updateController.start(),
    dispose() {
      coachController.dispose();
      credentialController.dispose();
      athleteController.dispose();
      conversationController.dispose();
      spendController.dispose();
      updateController.dispose();
      releaseNotesController.dispose();
      store.getState().bindSettingsPorts(null);
    },
  };
}

let harness: ReturnType<typeof createHarness> | undefined;

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "settings",
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
    chatActions: null,
  });
});

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  useEnduragentStore.setState({
    activeView: "chat",
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

async function renderSettings(options: HarnessOptions = {}) {
  harness = createHarness(options);
  render(<SettingsView />);
  await screen.findByRole("button", { name: "Save coach route" });
  await waitFor(() => {
    expect(useEnduragentStore.getState().settings.coach.status).toBe("ready");
    expect(useEnduragentStore.getState().settings.conversation.status).toBe("ready");
    expect(useEnduragentStore.getState().settings.credentials.status).toBe("ready");
  });
  return harness;
}

describe("settings mutation lock", () => {
  it("disables other panes and blocks leaving Settings while one pane saves", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const subject = await renderSettings({
      configureRuntime: () => pending.promise,
    });

    await user.clear(screen.getByLabelText("Idle reset (minutes)"));
    await user.type(screen.getByLabelText("Idle reset (minutes)"), "45");
    await user.click(screen.getByRole("button", { name: "Save conversation settings" }));

    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.savingOwners).toEqual(["session"]);
    });
    expect(screen.getByRole("region", { name: "Settings" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Save athlete ID" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Provider/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open setup" })).toBeDisabled();

    act(() => {
      useEnduragentStore.getState().setActiveView("chat");
    });
    expect(useEnduragentStore.getState().activeView).toBe("settings");

    await act(async () => {
      pending.resolve({
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: true, session: true },
      });
      await pending.promise;
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.savingOwners).toEqual([]);
    });
    expect(screen.getByRole("region", { name: "Settings" })).not.toHaveAttribute("aria-busy");
    expect(subject.calls.some((call) => call.method === "configureRuntime")).toBe(true);
  });
});

describe("conversation settings", () => {
  it("sends only the dirty fields", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    await user.clear(screen.getByLabelText("Idle reset (minutes)"));
    await user.type(screen.getByLabelText("Idle reset (minutes)"), "45");
    await user.click(screen.getByRole("button", { name: "Save conversation settings" }));

    await waitFor(() => {
      expect(subject.calls.filter((call) => call.method === "configureRuntime")).toHaveLength(1);
    });
    expect(subject.calls.find((call) => call.method === "configureRuntime")?.params).toEqual({
      session: { idleMinutes: 45 },
    });
  });

  it("keeps a managed field read-only", async () => {
    await renderSettings({
      runtime: () =>
        snapshot({
          session: {
            ...snapshot().session,
            managedByEnvironment: {
              ...snapshot().session.managedByEnvironment,
              timezone: true,
            },
          },
        }),
    });

    expect(screen.getByLabelText("Timezone")).toBeDisabled();
    expect(
      screen.getAllByText("Managed by an environment variable. Change it outside Enduragent."),
    ).not.toHaveLength(0);
  });
});

describe("credential deletion", () => {
  it("confirms in two steps and restores focus when cancelled", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    const remove = screen.getByRole("button", { name: "Delete the OpenRouter credential" });
    await user.click(remove);

    expect(screen.getByText("Delete the OpenRouter credential?")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });
    expect(subject.deleteCredential).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Delete the OpenRouter credential" }),
      ).toHaveFocus();
    });
    expect(screen.getByText("Credential deletion cancelled.")).toBeInTheDocument();
  });

  it("deletes on the second confirmation and announces the outcome", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );

    await waitFor(() => {
      expect(subject.deleteCredential).toHaveBeenCalledWith({ credential: "openrouter" });
    });
    await waitFor(() => {
      expect(screen.getByText("Credential deleted locally.")).toBeInTheDocument();
    });
  });
});

describe("coach route", () => {
  it("saves a custom model through the sentinel option", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    await user.selectOptions(screen.getByRole("combobox", { name: /^Model$/u }), "__custom__");
    const custom = await screen.findByLabelText("Custom model name");
    await waitFor(() => {
      expect(custom).toHaveFocus();
    });
    await user.type(custom, "vendor/experimental");
    await user.click(screen.getByRole("button", { name: "Save coach route" }));

    await waitFor(() => {
      expect(subject.applyLlmSelection).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "vendor/experimental",
        endpoint: { mode: "automatic" },
      });
    });
    expect(await screen.findByText("Coach settings saved.")).toBeInTheDocument();
  });

  it("offers Open Setup when the provider needs a credential", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      applyLlmSelection: async () => ({ status: "refused", reason: "credential-required" }),
    });

    await user.selectOptions(screen.getByRole("combobox", { name: /Provider/u }), "openrouter");
    await user.click(screen.getByRole("button", { name: "Save coach route" }));

    const openSetup = await screen.findByRole("button", { name: "Open Setup" });
    await user.click(openSetup);
    expect(subject.openSetup).toHaveBeenCalledTimes(1);
  });
});

describe("application section", () => {
  it("runs the update action the state calls for", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      updateState: { status: "downloaded", version: "1998.7.7" },
    });
    await act(async () => {
      await subject.startUpdate();
    });

    const action = await screen.findByRole("button", {
      name: "Restart to update to version 1998.7.7",
    });
    await user.click(action);

    await waitFor(() => {
      expect(subject.restartToUpdate).toHaveBeenCalledTimes(1);
    });
    expect(subject.checkForUpdates).not.toHaveBeenCalled();
  });

  it("opens release notes and offers a retry when they are unavailable", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    await renderSettings({
      releaseNotes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic release notes failure");
        return {
          status: "available",
          version: "1998.7.6",
          notes: ["Added a synthetic quick action."],
          releaseUrl: "https://example.invalid/release",
        };
      },
    });

    await user.click(screen.getByRole("button", { name: "What’s new" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        "Release notes aren’t available right now. Check your connection and try again.",
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("Added a synthetic quick action.")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "What’s new in 1998.7.6" })).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Close release notes" }));
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.releaseNotesOpen).toBe(false);
    });
  });
});

describe("spending", () => {
  it("publishes the cap warning for the chat surface and saves a new cap", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();
    act(() => {
      subject.spendController.start();
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.spend.summary).not.toBeNull();
    });

    expect(useEnduragentStore.getState().settings.spend.warning).toBe(
      "You’ve reached today’s $0.50 spend cap. You can keep chatting; this is a warning, not a block.",
    );
    expect(screen.getByText("$0.60+ / $0.50")).toBeInTheDocument();

    const cap = screen.getByLabelText("Daily cap (USD)");
    await user.clear(cap);
    await user.type(cap, "0.75");
    await user.click(screen.getByRole("button", { name: "Save cap" }));

    await waitFor(() => {
      expect(subject.calls.filter((call) => call.method === "setDailySpendCap")).toEqual([
        { method: "setDailySpendCap", params: { dailyCapUsd: 0.75 } },
      ]);
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.spend.warning).toBeNull();
    });
  });

  it("keeps a cap edit in progress across a refresh and reconciles the committed cap", async () => {
    const user = userEvent.setup();
    const pending = [
      spendSummary(),
      spendSummary({ knownSpendUsd: 0.2 }),
      spendSummary({ dailyCapUsd: 0.75 }),
      spendSummary({ dailyCapUsd: 0.5 }),
    ];
    const subject = await renderSettings({
      spend: async () => pending.shift() ?? spendSummary(),
    });
    act(() => {
      subject.spendController.start();
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.spend.summary).not.toBeNull();
    });

    const cap = screen.getByLabelText("Daily cap (USD)") as HTMLInputElement;
    expect(cap.value).toBe("0.5");
    await user.clear(cap);
    await user.type(cap, "0.75");
    const draft = cap.value;
    expect(Number(draft)).toBe(0.75);
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(true);

    await act(async () => {
      await subject.spendController.refresh();
    });
    expect(useEnduragentStore.getState().settings.spend.summary?.knownSpendUsd).toBe(0.2);
    expect(cap.value).toBe(draft);
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(true);

    await act(async () => {
      await subject.spendController.refresh();
    });
    expect(Number(cap.value)).toBe(0.75);
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(false);

    await act(async () => {
      await subject.spendController.refresh();
    });
    expect(cap.value).toBe("0.5");
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(false);
  });
});
