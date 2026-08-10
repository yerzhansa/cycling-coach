import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TelegramControlStatus,
  TelegramSettingsAction,
  TelegramSettingsState,
} from "../src/settings/telegram-controller.js";
import { useEnduragentStore } from "../src/state/store.js";
import {
  TELEGRAM_AVAILABILITY_COPY,
  TELEGRAM_CREATE_COPY,
  TELEGRAM_REMOVE_COPY,
  TELEGRAM_REPLACEMENT_COPY,
} from "../src/ui/onboarding/copy.js";
import {
  mountWizard,
  panel,
  readyTelegramSettings,
  resetOnboardingStore,
  setTelegramSettings,
  setupCard,
  setupRow,
  testBridge,
} from "./onboarding-harness.js";

const UNCONFIGURED: TelegramControlStatus = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: false,
  gapWarning: { state: "clear" },
};

const VERIFIED: TelegramControlStatus = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "ready", username: "synthetic_coach_bot" },
  pairing: { state: "unpaired" },
  credentialConfigured: true,
  gapWarning: { state: "clear" },
};

const REPLACEMENT: TelegramControlStatus = {
  ...VERIFIED,
  bot: { state: "ready", username: "replacement_coach_bot" },
};

const CLOSED_UNCONFIGURED: TelegramControlStatus = {
  channel: {
    desiredState: "disabled",
    state: "failed",
    errorCode: "telegram-control-failed",
  },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: false,
  gapWarning: { state: "clear" },
};

const REDACTED_CONFIGURED: TelegramControlStatus = {
  channel: {
    desiredState: "disabled",
    state: "failed",
    errorCode: "telegram-credential-unavailable",
  },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: true,
  gapWarning: { state: "clear" },
};

function workingTelegramSettings(
  operation: TelegramSettingsAction,
  telegram: TelegramControlStatus,
): Extract<TelegramSettingsState, { readonly status: "working" }> {
  return {
    status: "working",
    operation,
    telegram,
    allowedSenders: { senders: [] },
    senderLoadFailed: false,
    announcement: "controller-specific working copy",
    healthAnnouncement: "",
    feedback: { tone: "status", message: "controller-specific working copy" },
  };
}

function publishTelegram(state: TelegramSettingsState, saving = false): void {
  act(() => {
    const current = useEnduragentStore.getState().settings;
    useEnduragentStore.setState({
      settings: {
        ...current,
        telegram: state,
        savingOwners: saving ? ["telegram"] : [],
      },
    });
  });
}

describe("Chat Telegram setup row", () => {
  afterEach(() => resetOnboardingStore());

  it("sits after Training only in Chat and uses the approved logo-free clipboard flow", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();

    expect(
      Array.from(setupCard().children)
        .map((child) => (child as HTMLElement).dataset.setupRow ?? "")
        .filter(Boolean),
    ).toEqual(["ai", "training", "telegram", "injury-status"]);
    const row = setupRow("telegram");
    expect(row.querySelector("[data-setup-row-title]")).toHaveTextContent("Telegram");
    expect(row.querySelector("[data-telegram-optional]")).toHaveTextContent("Optional");
    expect(row).toHaveTextContent(TELEGRAM_AVAILABILITY_COPY);
    expect(row.querySelector('[data-setup-disc="pending"]')).not.toBeNull();
    expect(row.querySelector("img, input")).toBeNull();
    expect(screen.getByText(/required ready/u)).toBeVisible();
    expect(screen.getByText(/Telegram is optional and never blocks Chat/u)).toBeVisible();

    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    await user.click(create);

    const telegramPanel = panel("telegram");
    expect(create).toHaveAttribute("aria-expanded", "true");
    expect(telegramPanel).not.toBeNull();
    expect(telegramPanel?.textContent).toContain(TELEGRAM_CREATE_COPY);
    expect(
      within(telegramPanel as HTMLElement).getByRole("link", { name: "@BotFather" }),
    ).toHaveAttribute("href", "https://t.me/BotFather");
    expect(telegramPanel?.querySelector("img, input, textarea")).toBeNull();

    const useToken = within(telegramPanel as HTMLElement).getByRole("button", {
      name: "Use copied token",
    });
    expect(useToken).toHaveAttribute("data-telegram-action", "use-token");
    await user.click(useToken);
    expect(port.pasteToken).toHaveBeenCalledOnce();

    wizard.controller.dispose();
    wizard.rendered.unmount();
    resetOnboardingStore();
    setTelegramSettings(readyTelegramSettings(VERIFIED));
    const settingsWizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
      placement: "settings",
    });
    await settingsWizard.open();

    expect(document.querySelector('[data-setup-row="telegram"]')).toBeNull();
    expect(screen.queryByText(/Telegram is optional and never blocks Chat/u)).toBeNull();
    expect(document.querySelector("[data-setup-readiness]")).toBeNull();
    settingsWizard.controller.dispose();
  });

  it("shows generic progress and closes only after the controller reports applied verification", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Create Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));

    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.queryByText(/Reading and verifying/u)).toBeNull();

    publishTelegram(
      readyTelegramSettings(UNCONFIGURED, {
        tone: "error",
        message: "Telegram rejected the copied token. No Telegram bot was changed.",
      }),
    );
    await waitFor(() => {
      expect(panel("telegram")).not.toBeNull();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Telegram rejected the copied token");
    expect(setupRow("telegram").dataset.state).toBe("pending");

    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "success",
        message: "Telegram is off.",
      }),
    );

    await waitFor(() => {
      expect(panel("telegram")).toBeNull();
    });
    expect(setupRow("telegram").dataset.state).toBe("ready");
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    expect(screen.getByRole("button", { name: "Change Telegram bot" })).toHaveTextContent("Change");
    expect(screen.getByRole("button", { name: "Change Telegram bot" })).toHaveFocus();
    expect(port.pasteToken).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("offers one retry and restores Create focus when uncertain setup resolves as missing", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Create Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message:
          "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    });
    expect(panel("telegram")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));

    await waitFor(() => {
      expect(panel("telegram")).toBeNull();
    });
    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    expect(create).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.pasteToken).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("keeps a known-current uncertain replacement visible until an authoritative retry", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message:
          "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        "could not confirm whether it finished",
      );
    });
    expect(panel("telegram")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(REPLACEMENT));

    await waitFor(() => {
      expect(panel("telegram")).toBeNull();
    });
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @replacement_coach_bot");
    expect(screen.getByRole("button", { name: "Change Telegram bot" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.pasteToken).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it.each([
    ["a closed control fallback", CLOSED_UNCONFIGURED],
    ["a redacted saved credential", REDACTED_CONFIGURED],
  ] as const)("requires a fresh status before token mutation for %s", async (_label, status) => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(status));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();

    expect(screen.queryByRole("button", { name: "Create Telegram bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change Telegram bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use copied token" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    expect(port.pasteToken).not.toHaveBeenCalled();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));
    expect(screen.getByRole("button", { name: "Create Telegram bot" })).toBeVisible();

    wizard.controller.dispose();
  });

  it("restores a replacement that settles while the Chat setup row is unmounted", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const first = mountWizard({ bridge });
    await first.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", VERIFIED), true);
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();

    first.controller.dispose();
    first.rendered.unmount();
    const working = mountWizard({ bridge });
    await working.open();
    expect(panel("telegram")?.textContent).toContain("Replace @synthetic_coach_bot?");
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    working.controller.dispose();
    working.rendered.unmount();
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "error",
        message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
      }),
    );

    const refused = mountWizard({ bridge });
    await refused.open();
    expect(
      within(panel("telegram") as HTMLElement).getByRole("heading", {
        name: "Telegram rejected the copied token",
      }),
    ).toBeVisible();
    expect(panel("telegram")?.textContent).not.toContain(TELEGRAM_REPLACEMENT_COPY);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Telegram rejected the copied token. The current Telegram bot is unchanged.",
    );
    const retry = screen.getByRole("button", { name: "Use copied token" });
    expect(retry).toBeEnabled();
    expect(retry).toHaveAttribute("data-telegram-action", "use-token");

    await user.click(retry);
    publishTelegram(workingTelegramSettings("paste-token", VERIFIED), true);
    refused.controller.dispose();
    refused.rendered.unmount();
    publishTelegram(
      readyTelegramSettings(REPLACEMENT, {
        tone: "success",
        message: "Telegram is off.",
      }),
    );

    const succeeded = mountWizard({ bridge });
    await succeeded.open();
    expect(panel("telegram")).toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @replacement_coach_bot");
    expect(screen.getByRole("button", { name: "Change Telegram bot" })).toBeVisible();
    expect(port.pasteToken).toHaveBeenCalledTimes(2);
    succeeded.controller.dispose();
  });

  it("keeps the verified bot and replacement panel after refused or uncertain changes", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const change = screen.getByRole("button", { name: "Change Telegram bot" });
    await user.click(change);

    expect(panel("telegram")?.textContent).toContain(TELEGRAM_REPLACEMENT_COPY);
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "error",
        message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("current Telegram bot is unchanged");
    });
    expect(
      within(panel("telegram") as HTMLElement).getByRole("heading", {
        name: "Telegram rejected the copied token",
      }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Telegram rejected the copied token. The current Telegram bot is unchanged.",
    );
    expect(panel("telegram")?.textContent).not.toContain(TELEGRAM_REPLACEMENT_COPY);
    expect(panel("telegram")).not.toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("@synthetic_coach_bot");

    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message:
          "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
      );
    });
    expect(panel("telegram")).not.toBeNull();
    expect(panel("telegram")?.textContent).toContain("Replace @synthetic_coach_bot?");
    expect(panel("telegram")?.textContent).toContain(TELEGRAM_REPLACEMENT_COPY);
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(CLOSED_UNCONFIGURED));
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
    );
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    expect(port.pasteToken).toHaveBeenCalledTimes(2);

    wizard.controller.dispose();
    wizard.rendered.unmount();
    const reopened = mountWizard({ bridge });
    await reopened.open();
    expect(panel("telegram")?.textContent).toContain("Replace @synthetic_coach_bot?");
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
    );
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    const reopenedChange = screen.getByRole("button", { name: "Change Telegram bot" });
    await user.click(screen.getByRole("button", { name: "Cancel Telegram bot replacement" }));
    await waitFor(() => expect(reopenedChange).toHaveFocus());
    expect(panel("telegram")).toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    reopened.controller.dispose();
    reopened.rendered.unmount();

    const collapsed = mountWizard({ bridge });
    await collapsed.open();
    expect(panel("telegram")).toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    const collapsedChange = screen.getByRole("button", { name: "Change Telegram bot" });
    await user.click(collapsedChange);
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      "The Telegram bot change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check the current bot before trying again.",
    );
    await user.click(collapsedChange);
    expect(panel("telegram")).toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    collapsed.controller.dispose();
    collapsed.rendered.unmount();

    const toggledClosed = mountWizard({ bridge });
    await toggledClosed.open();
    expect(panel("telegram")).toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    expect(screen.getByRole("button", { name: "Change Telegram bot" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Check again" }));
    publishTelegram(readyTelegramSettings(REPLACEMENT));
    await waitFor(() => {
      expect(setupRow("telegram")).toHaveTextContent("Bot verified · @replacement_coach_bot");
    });
    await waitFor(() => {
      expect(panel("telegram")).toBeNull();
    });
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(screen.getByRole("button", { name: "Change Telegram bot" })).toHaveFocus();
    toggledClosed.controller.dispose();
  });

  it("confirms local removal, restores focus on cancellation, and returns to Create after apply", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));

    const removeFromMac = screen.getByRole("button", { name: "Remove bot from this Mac" });
    expect(removeFromMac.className).toContain("text-danger");
    await user.click(removeFromMac);

    expect(panel("telegram-remove")?.textContent).toContain(TELEGRAM_REMOVE_COPY);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove bot from this Mac" })).toHaveFocus();
    });

    await user.click(screen.getByRole("button", { name: "Remove bot from this Mac" }));
    await user.click(screen.getByRole("button", { name: "Remove bot" }));
    expect(port.remove).toHaveBeenCalledOnce();
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
    publishTelegram(
      readyTelegramSettings(UNCONFIGURED, {
        tone: "success",
        message: "Telegram was removed from this Mac.",
      }),
    );

    await waitFor(() => {
      expect(panel("telegram-remove")).toBeNull();
    });
    expect(setupRow("telegram").dataset.state).toBe("pending");
    expect(screen.getByRole("button", { name: "Create Telegram bot" })).toHaveTextContent("Create");
    expect(screen.getByRole("button", { name: "Create Telegram bot" })).toHaveFocus();
    wizard.controller.dispose();
  });

  it("fails closed and offers an authoritative retry after uncertain removal across remount", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const first = mountWizard({ bridge });
    await first.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Remove bot from this Mac" }));
    await user.click(screen.getByRole("button", { name: "Remove bot" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);

    first.controller.dispose();
    first.rendered.unmount();
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message:
          "The Telegram change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check this setting before trying again.",
      }),
    );

    const reopened = mountWizard({ bridge });
    await reopened.open();

    expect(panel("telegram-remove")).not.toBeNull();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      "could not confirm whether it finished",
    );
    expect(screen.getByRole("button", { name: "Remove bot" })).toBeDisabled();
    expect(port.remove).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove bot" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "Remove bot" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    reopened.controller.dispose();
  });

  it("keeps a known-current uncertain removal visible until retry and restores action focus", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Remove bot from this Mac" }));
    await user.click(screen.getByRole("button", { name: "Remove bot" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message:
          "The Telegram change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check this setting before trying again.",
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        "could not confirm whether it finished",
      );
    });
    expect(panel("telegram-remove")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove bot" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    expect(port.remove).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove bot" })).toBeEnabled();
    });
    expect(panel("telegram-remove")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove bot" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("preserves uncertain removal through Cancel and keeps retry focus coherent", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Remove bot from this Mac" }));
    await user.click(screen.getByRole("button", { name: "Remove bot" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message:
          "The Telegram change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check this setting before trying again.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove bot" })).toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(panel("telegram-remove")).toBeNull();
    expect(panel("telegram")).not.toBeNull();
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      "could not confirm whether it finished",
    );
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove bot from this Mac" })).toBeDisabled();
    const retry = screen.getByRole("button", { name: "Check again" });
    expect(retry).toHaveFocus();
    expect(port.remove).toHaveBeenCalledOnce();

    await user.click(retry);
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove bot from this Mac" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "Remove bot from this Mac" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("closes stale removal recovery when retry confirms the bot is already gone", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Change Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Remove bot from this Mac" }));
    await user.click(screen.getByRole("button", { name: "Remove bot" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message:
          "The Telegram change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check this setting before trying again.",
      }),
    );

    expect(screen.getByRole("button", { name: "Remove bot" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));

    await waitFor(() => {
      expect(panel("telegram-remove")).toBeNull();
    });
    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    expect(setupRow("telegram").dataset.state).toBe("pending");
    expect(create).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });
});
