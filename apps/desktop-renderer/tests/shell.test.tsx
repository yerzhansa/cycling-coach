import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell.js";
import type { LegacyHosts } from "../src/legacy-boot.js";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice.js";
import { resetChatStream } from "../src/state/chat-stream.js";
import { useEnduragentStore } from "../src/state/store.js";

function stubActions(): ChatActions {
  return {
    submit: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
  };
}

describe("shell", () => {
  beforeEach(() => {
    useEnduragentStore.setState({
      activeView: "chat",
      legacyReady: true,
      chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
      chatActions: stubActions(),
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({ chat: EMPTY_CHAT_SURFACE, chatActions: null });
    resetChatStream();
  });

  it("renders the sidebar and the chat region by default", () => {
    render(<Shell onHostsReady={() => {}} />);

    expect(screen.getByText("Enduragent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
    expect(document.querySelector("div.thread")).not.toBeNull();
    expect(document.querySelector("div.composer-wrap")).not.toBeNull();
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(document.querySelector('.drawer[aria-label="Training data"]')).not.toBeNull();
  });

  it("hands every legacy host to the boot callback once", () => {
    const onHostsReady = vi.fn<(hosts: LegacyHosts) => void>();

    const { rerender } = render(<Shell onHostsReady={onHostsReady} />);
    rerender(<Shell onHostsReady={onHostsReady} />);

    expect(onHostsReady).toHaveBeenCalledTimes(1);
    const hosts = onHostsReady.mock.calls[0][0];
    expect(hosts.noticeHost.classList.contains("chat-notice-host__slot")).toBe(true);
    expect(hosts.topbar.classList.contains("topbar")).toBe(true);
    expect(hosts.spendRoot.classList.contains("spend-meter")).toBe(true);
    expect(hosts.spine.classList.contains("data-spine")).toBe(true);
    expect(hosts.drawer).toBeInstanceOf(HTMLDialogElement);
    expect(hosts.drawer.getAttribute("aria-label")).toBe("Training data");
  });

  it("switches the main region between the registered views", async () => {
    const user = userEvent.setup();
    render(<Shell onHostsReady={() => {}} />);

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
    const onHostsReady = vi.fn<(hosts: LegacyHosts) => void>();
    render(<Shell onHostsReady={onHostsReady} />);
    const thread = document.querySelector("div.thread");
    const noticeHost = onHostsReady.mock.calls[0][0].noticeHost;

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("region", { name: "Settings" });

    expect(thread?.isConnected).toBe(true);
    expect(noticeHost.isConnected).toBe(true);
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(onHostsReady).toHaveBeenCalledTimes(1);
  });

  it("disables the new chat button until the chat controller is bound", () => {
    useEnduragentStore.setState({ chatActions: null });
    render(<Shell onHostsReady={() => {}} />);

    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("routes the new chat button at the controller's new-conversation flow", async () => {
    const user = userEvent.setup();
    const actions = stubActions();
    useEnduragentStore.setState({ chatActions: actions, activeView: "settings" });
    render(<Shell onHostsReady={() => {}} />);

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
    render(<Shell onHostsReady={() => {}} />);

    const opener = screen.getByRole("button", { name: "New chat" });
    expect(opener).toBeEnabled();
    expect(opener).toHaveAttribute("aria-disabled", "true");

    await user.click(opener);
    expect(actions.openNewConversation).not.toHaveBeenCalled();
  });
});
