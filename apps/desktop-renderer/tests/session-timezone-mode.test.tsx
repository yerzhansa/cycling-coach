import type { CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import { createSessionSettingsController } from "../src/settings/session-controller.js";
import {
  createSessionTimezoneModeController,
  type SessionTimezoneModeBridge,
} from "../src/settings/timezone-mode-controller.js";
import { createConversationSettingsAdapter } from "../src/state/adapters/settings.js";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice.js";
import { LOADING_SESSION_TIMEZONE_MODE } from "../src/state/session-timezone-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { TIMEZONE_MODE_COPY } from "../src/ui/settings/copy.js";
import { ConversationSection } from "../src/ui/settings/ConversationSection.js";

const HOST = "Asia/Qyzylorda";
const ELSEWHERE = "Africa/Harare";

function snapshot(timezone: string): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "claude-sonnet", credential_configured: true },
    intervals: {
      athlete_id: "0",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone,
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function clientFor(timezone: string): DesktopCoachClientProvider {
  const client = {
    handshake: {} as never,
    call: async (method: string) => {
      if (method === "getRuntimeConfig") return snapshot(timezone);
      return {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: false, intervals: false, session: true },
      };
    },
    close: vi.fn(async () => {}),
  } as unknown as CoachClient;
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
}

function createHarness(input: {
  readonly storedTimezone: string;
  readonly setting: DesktopSessionTimezoneSetting;
  readonly persist?: (mode: DesktopSessionTimezoneMode) => Promise<boolean>;
}) {
  const store = useEnduragentStore;
  const chosen: DesktopSessionTimezoneMode[] = [];
  const bridge: SessionTimezoneModeBridge = {
    sessionTimezoneSetting: async () => input.setting,
    setSessionTimezoneMode: async (mode) => {
      chosen.push(mode);
      return input.persist === undefined ? true : input.persist(mode);
    },
  };
  const modeController = createSessionTimezoneModeController({
    bridge,
    view: { render: (next) => store.getState().setSessionTimezoneMode(next) },
  });
  store.getState().bindSessionTimezoneModeActions({
    choose: (mode) => {
      void modeController.choose(mode);
    },
  });
  const conversationAdapter = createConversationSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ conversation: state }),
  });
  const conversationController = createSessionSettingsController({
    clients: clientFor(input.storedTimezone),
    beginMutation: () => store.getState().beginSettingsMutation("session"),
    view: conversationAdapter.view,
  });
  store.getState().bindSettingsPorts({
    panes: { activate: () => {}, close: () => {} },
    coach: {
      retry: () => {},
      changeProvider: () => {},
      changeModel: () => {},
      changeCustomModel: () => {},
      save: () => {},
      openSetup: () => {},
    },
    credentials: {
      retry: () => {},
      requestDelete: () => {},
      cancelDelete: () => {},
      confirmDelete: () => {},
      setupOpened: () => {},
      openSetup: () => {},
    },
    athlete: { retry: () => {}, change: () => {}, save: () => {}, openSetup: () => {} },
    conversation: conversationAdapter.port,
    telegram: {
      retry: () => {},
      pasteToken: () => {},
      enable: () => {},
      disable: () => {},
      remove: () => {},
      reconcile: () => {},
      removeWebhook: () => {},
      beginPairing: () => {},
      cancelPairing: () => {},
      acknowledgeGapWarning: () => {},
      addSender: () => {},
      removeSender: () => {},
    },
    spend: { changeCap: () => {}, save: () => {} },
    update: { activate: () => {} },
    releaseNotes: { open: () => {}, retry: () => {}, close: () => {} },
    units: { set: () => {} },
  } as never);
  return { chosen, modeController, conversationController };
}

function timezoneInput(): HTMLInputElement {
  return screen.getByLabelText("Timezone") as HTMLInputElement;
}

beforeEach(() => {
  useEnduragentStore.setState({
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
    sessionTimezoneMode: LOADING_SESSION_TIMEZONE_MODE,
    sessionTimezoneModeActions: null,
  });
});

afterEach(() => {
  cleanup();
  useEnduragentStore.setState({ settingsPorts: null, sessionTimezoneModeActions: null });
});

describe("timezone source setting", () => {
  it("lets a fresh install whose stored zone already equals the host switch to a fixed zone", async () => {
    const harness = createHarness({
      storedTimezone: HOST,
      setting: { status: "editable", mode: "follow", host: HOST },
    });
    render(<ConversationSection />);
    await act(async () => {
      await harness.modeController.start();
      await harness.conversationController.activate();
    });

    const saveButton = screen.getByRole("button", { name: "Save conversation settings" });
    expect(saveButton).toBeDisabled();
    expect(timezoneInput().value).toBe(HOST);
    expect(timezoneInput()).toBeDisabled();

    const fixed = screen.getByRole("button", { name: TIMEZONE_MODE_COPY.fixedLabel });
    expect(fixed).toBeEnabled();
    await userEvent.click(fixed);

    await waitFor(() => expect(fixed).toHaveAttribute("aria-pressed", "true"));
    expect(harness.chosen).toEqual(["fixed"]);
    expect(
      screen.getByRole("button", { name: TIMEZONE_MODE_COPY.followLabel }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(timezoneInput()).toBeEnabled();
    expect(harness.modeController.state()).toEqual({
      status: "ready",
      mode: "fixed",
      host: HOST,
    });
  });

  it("surfaces a failed write instead of reporting the new source", async () => {
    const harness = createHarness({
      storedTimezone: ELSEWHERE,
      setting: { status: "editable", mode: "follow", host: HOST },
      persist: async () => false,
    });
    render(<ConversationSection />);
    await act(async () => {
      await harness.modeController.start();
      await harness.conversationController.activate();
    });

    await userEvent.click(screen.getByRole("button", { name: TIMEZONE_MODE_COPY.fixedLabel }));

    await waitFor(() => expect(screen.getByText(TIMEZONE_MODE_COPY.failed)).toBeTruthy());
    expect(harness.chosen).toEqual(["fixed"]);
    expect(harness.modeController.state()).toEqual({
      status: "failed",
      mode: "follow",
      host: HOST,
    });
    expect(
      screen.getByRole("button", { name: TIMEZONE_MODE_COPY.followLabel }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: TIMEZONE_MODE_COPY.fixedLabel }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("waits for the write before it reports the new source", async () => {
    let release: ((stored: boolean) => void) | undefined;
    const harness = createHarness({
      storedTimezone: HOST,
      setting: { status: "editable", mode: "follow", host: HOST },
      persist: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    render(<ConversationSection />);
    await act(async () => {
      await harness.modeController.start();
      await harness.conversationController.activate();
    });

    await userEvent.click(screen.getByRole("button", { name: TIMEZONE_MODE_COPY.fixedLabel }));
    await waitFor(() => expect(harness.modeController.state().status).toBe("saving"));
    expect(harness.modeController.state()).toEqual({
      status: "saving",
      mode: "follow",
      host: HOST,
    });

    await act(async () => {
      release?.(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.modeController.state().status).toBe("ready"));
  });

  it("shows the environment owns the zone instead of an editable control", async () => {
    const harness = createHarness({
      storedTimezone: HOST,
      setting: { status: "environment-managed", timezone: "Europe/Berlin" },
    });
    render(<ConversationSection />);
    await act(async () => {
      await harness.modeController.start();
    });

    expect(screen.queryByRole("button", { name: TIMEZONE_MODE_COPY.fixedLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: TIMEZONE_MODE_COPY.followLabel })).toBeNull();
    expect(screen.getByText("COACH_TZ sets the timezone to Europe/Berlin.")).toBeTruthy();
    expect(harness.chosen).toEqual([]);
  });

  it("asks the athlete to pick when nothing is persisted yet", async () => {
    const harness = createHarness({
      storedTimezone: ELSEWHERE,
      setting: { status: "editable", mode: null, host: HOST },
    });
    render(<ConversationSection />);
    await act(async () => {
      await harness.modeController.start();
      await harness.conversationController.activate();
    });

    expect(
      screen.getByRole("button", { name: TIMEZONE_MODE_COPY.followLabel }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: TIMEZONE_MODE_COPY.fixedLabel }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(timezoneInput()).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: TIMEZONE_MODE_COPY.followLabel }));
    await waitFor(() => expect(harness.modeController.state().status).toBe("ready"));
    expect(harness.chosen).toEqual(["follow"]);
    expect(timezoneInput()).toBeDisabled();
  });
});
