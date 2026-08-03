import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TelegramAllowedSenders,
  TelegramControlStatus,
  TelegramSettingsState,
} from "../src/settings/telegram-controller.js";
import { EMPTY_SETTINGS_SURFACE, type TelegramSettingsPort } from "../src/state/settings-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { TelegramSection } from "../src/ui/settings/TelegramSection.js";

function status(overrides: Partial<TelegramControlStatus> = {}): TelegramControlStatus {
  return {
    channel: { desiredState: "disabled", state: "disabled" },
    bot: { state: "unconfigured" },
    pairing: { state: "unpaired" },
    credentialConfigured: false,
    gapWarning: { state: "clear" },
    ...overrides,
  };
}

function readyState(
  telegram: TelegramControlStatus,
  allowedSenders: TelegramAllowedSenders = { senders: [] },
): TelegramSettingsState {
  return {
    status: "ready",
    telegram,
    allowedSenders,
    senderLoadFailed: false,
    announcement: "",
  };
}

function setup(next: TelegramSettingsState) {
  const port = {
    retry: vi.fn(),
    pasteToken: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    remove: vi.fn(),
    reconcile: vi.fn(),
    removeWebhook: vi.fn(),
    beginPairing: vi.fn(),
    cancelPairing: vi.fn(),
    acknowledgeGapWarning: vi.fn(),
    addSender: vi.fn(),
    removeSender: vi.fn(),
  } satisfies TelegramSettingsPort;
  useEnduragentStore.setState({
    settings: { ...EMPTY_SETTINGS_SURFACE, telegram: next },
    settingsPorts: { telegram: port } as never,
  });
  render(<TelegramSection />);
  return port;
}

beforeEach(() => {
  useEnduragentStore.setState({
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

describe("Telegram settings surface", () => {
  it("explains the dedicated-bot boundary and accepts a token only from the clipboard", async () => {
    const user = userEvent.setup();
    const port = setup(readyState(status()));
    const section = screen.getByRole("region", { name: "Telegram" });

    expect(within(section).getByText(/creates a new @username and Telegram chat/u)).toBeVisible();
    expect(
      within(section).getByText(/visible history from a previous bot does not move/u),
    ).toBeVisible();
    expect(
      within(section).getByText(/athlete memory, training data and plans are shared/iu),
    ).toBeVisible();
    expect(within(section).getByText(/Mac is awake and online/u)).toBeVisible();
    expect(within(section).getByRole("link", { name: "@BotFather" })).toHaveAttribute(
      "href",
      "https://t.me/BotFather",
    );
    expect(within(section).queryByRole("textbox")).toBeNull();

    await user.click(within(section).getByRole("button", { name: "Paste token from clipboard" }));
    expect(port.pasteToken).toHaveBeenCalledWith();
  });

  it("shows the short-lived pairing code and explicit webhook removal", async () => {
    const user = userEvent.setup();
    const webhookPort = setup(
      readyState(
        status({
          bot: { state: "webhook-removal-required", username: "desktop_coach_bot" },
          credentialConfigured: true,
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Remove webhook" }));
    expect(webhookPort.removeWebhook).toHaveBeenCalledWith();

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          telegram: readyState(
            status({
              channel: { desiredState: "enabled", state: "starting" },
              bot: { state: "ready", username: "desktop_coach_bot" },
              pairing: {
                state: "awaiting-code",
                code: "A1B2C3",
                expiresAt: "2098-07-06T12:01:00.000Z",
              },
              credentialConfigured: true,
            }),
          ),
        },
      });
    });

    expect(screen.getByLabelText("Telegram pairing code")).toHaveTextContent("A1B2C3");
    expect(screen.getByText(/first account to send it becomes the primary user/u)).toBeVisible();
  });

  it("manages paired users without offering removal for the primary user", async () => {
    const user = userEvent.setup();
    const port = setup(
      readyState(
        status({
          channel: { desiredState: "enabled", state: "online" },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
          gapWarning: {
            state: "possible-message-loss",
            detectedAt: "1998-07-06T12:00:00.000Z",
          },
        }),
        {
          senders: [
            { senderId: 101, role: "primary" },
            { senderId: 202, role: "additional" },
          ],
        },
      ),
    );

    expect(screen.getByText("@desktop_coach_bot")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(port.acknowledgeGapWarning).toHaveBeenCalledWith();

    await user.click(screen.getByText("Advanced · allowed users"));
    const users = screen.getByRole("list", { name: "Allowed Telegram users" });
    expect(within(users).getByText("Primary user · required")).toBeVisible();
    expect(within(users).queryByRole("button", { name: "Remove Telegram user 101" })).toBeNull();

    await user.click(within(users).getByRole("button", { name: "Remove Telegram user 202" }));
    expect(port.removeSender).toHaveBeenCalledWith(202);

    const senderId = screen.getByLabelText("Add a Telegram user ID");
    await user.type(senderId, "9");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByText(/at least two digits/u)).toBeVisible();
    expect(port.addSender).not.toHaveBeenCalled();

    await user.clear(senderId);
    await user.type(senderId, "303");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(port.addSender).toHaveBeenCalledWith(303);
  });

  it("requires confirmation before removing the encrypted bot credential", async () => {
    const user = userEvent.setup();
    const port = setup(
      readyState(
        status({
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Remove bot from this Mac" }));
    expect(screen.getByText("Remove @desktop_coach_bot from this Mac?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(port.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove Telegram bot" }));
    expect(port.remove).toHaveBeenCalledWith();
  });
});
