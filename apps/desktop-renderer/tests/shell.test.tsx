import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell.js";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice.js";
import { resetChatStream } from "../src/state/chat-stream.js";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice.js";
import { useEnduragentStore } from "../src/state/store.js";

function stubActions(): ChatActions {
  return {
    submit: vi.fn(),
    removeQueued: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
  };
}

async function preloadLazyViews(): Promise<void> {
  await Promise.all([
    import("../src/ui/archive/ArchiveView.js"),
    import("../src/ui/training/TrainingView.js"),
    import("../src/ui/settings/SettingsView.js"),
  ]);
}

describe("shell", () => {
  beforeAll(preloadLazyViews);

  beforeEach(() => {
    useEnduragentStore.setState({
      activeView: "chat",
      runtimeReady: true,
      chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
      chatActions: stubActions(),
      onboarding: READY_ONBOARDING,
      onboardingActions: null,
      onboardingStartupSettled: true,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({
      chat: EMPTY_CHAT_SURFACE,
      chatActions: null,
      onboarding: CLOSED_ONBOARDING,
      onboardingActions: null,
      onboardingStartupSettled: false,
    });
    resetChatStream();
  });

  it("renders the sidebar and the chat region by default", () => {
    render(<Shell onReady={() => {}} />);

    expect(screen.getByText("Enduragent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
    expect(document.querySelector("div.thread")).not.toBeNull();
    expect(document.querySelector("div.composer-wrap")).not.toBeNull();
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(document.querySelector("button.sync-chip")).not.toBeNull();
    expect(document.querySelector('[data-sidebar-setup-readiness="ready"]')).toHaveTextContent(
      "Ready",
    );
    expect(document.querySelector('[data-view="chat"]')).not.toBeNull();
    expect(document.querySelector('[data-onboarding="settled"]')).not.toBeNull();
  });

  it("retires the training drawer, data spine and topbar strip", () => {
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('.drawer[aria-label="Training data"]')).toBeNull();
    expect(document.querySelector(".data-spine")).toBeNull();
    expect(document.querySelector("header.topbar")).toBeNull();
    expect(document.querySelector(".setup-button")).toBeNull();
  });

  it("signals boot readiness once", () => {
    const onReady = vi.fn<() => void>();

    const { rerender } = render(<Shell onReady={onReady} />);
    rerender(<Shell onReady={onReady} />);

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("switches the main region between the registered views", async () => {
    const user = userEvent.setup();
    render(<Shell onReady={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Past chats" }));
    expect(await screen.findByRole("region", { name: "Past chats" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Training" }));
    expect(await screen.findByRole("region", { name: "Training" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("region", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "App palette" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    });
    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
  });

  it("keeps the chat surface mounted while another view is shown", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn<() => void>();
    render(<Shell onReady={onReady} />);
    const thread = document.querySelector("div.thread");
    const noticeHost = document.querySelector("div.chat-notice-host");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("region", { name: "Settings" });

    expect(thread?.isConnected).toBe(true);
    expect(noticeHost?.isConnected).toBe(true);
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("mounts exactly one setup host while moving between Chat and Settings", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({ onboarding: CLOSED_ONBOARDING });
    render(<Shell onReady={() => {}} />);

    expect(document.querySelectorAll('[data-setup-host="chat"]')).toHaveLength(1);
    expect(document.querySelectorAll("#setup-panel-title")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("region", { name: "Settings" });
    expect(document.querySelectorAll('[data-setup-host="chat"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-setup-host="settings"]')).toHaveLength(1);
    expect(document.querySelectorAll("#setup-panel-title")).toHaveLength(1);
  });

  it("keeps the selected destination active while setup is required", async () => {
    useEnduragentStore.setState({
      activeView: "training",
      onboarding: { ...CLOSED_ONBOARDING, open: true },
    });
    render(<Shell onReady={() => {}} />);

    expect(await screen.findByRole("region", { name: "Training" })).toBeInTheDocument();
    expect(document.querySelector('[data-view="training"]')).not.toBeNull();
    expect(document.querySelector('[data-view="setup"]')).toBeNull();
    expect(document.querySelector("[data-setup-host]")).toBeNull();
    expect(document.querySelector('[data-sidebar-setup-readiness="waiting"]')).toHaveTextContent(
      "Waiting for setup",
    );
    expect(useEnduragentStore.getState().activeView).toBe("training");
  });

  it("never renders Setup while onboarding is closed", async () => {
    useEnduragentStore.setState({
      activeView: "settings",
      onboarding: CLOSED_ONBOARDING,
    });
    render(<Shell onReady={() => {}} />);

    expect(await screen.findByRole("region", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Setup" })).toBeNull();
    expect(document.querySelector('[data-view="setup"]')).toBeNull();
  });

  it("reports onboarding startup as pending until the decision settles", () => {
    useEnduragentStore.setState({ onboardingStartupSettled: false });
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('[data-onboarding="pending"]')).not.toBeNull();

    act(() => {
      useEnduragentStore.getState().setOnboardingStartupSettled(true);
    });
    expect(document.querySelector('[data-onboarding="settled"]')).not.toBeNull();
  });

  it("disables the new chat button until the chat controller is bound", () => {
    useEnduragentStore.setState({ chatActions: null });
    render(<Shell onReady={() => {}} />);

    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("routes the new chat button at the controller's new-conversation flow", async () => {
    const user = userEvent.setup();
    const actions = stubActions();
    useEnduragentStore.setState({ chatActions: actions, activeView: "settings" });
    render(<Shell onReady={() => {}} />);

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(actions.openNewConversation).toHaveBeenCalledTimes(1);
    expect(useEnduragentStore.getState().activeView).toBe("chat");
  });

  it("keeps the new chat button focusable while a reset outcome is uncertain", async () => {
    const user = userEvent.setup();
    const actions = stubActions();
    useEnduragentStore.setState({
      chatActions: actions,
      chat: {
        ...EMPTY_CHAT_SURFACE,
        newConversationUnavailable: true,
        resetPhase: "uncertain",
      },
    });
    render(<Shell onReady={() => {}} />);

    const opener = screen.getByRole("button", { name: "New chat" });
    expect(opener).toBeEnabled();
    expect(opener).toHaveAttribute("aria-disabled", "true");

    await user.click(opener);
    expect(actions.openNewConversation).not.toHaveBeenCalled();
  });
});
