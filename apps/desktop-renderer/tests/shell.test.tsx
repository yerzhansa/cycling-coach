import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell.js";
import type { LegacyHosts } from "../src/legacy-boot.js";
import { useEnduragentStore } from "../src/state/store.js";

function resetStore(): void {
  useEnduragentStore.setState({ activeView: "chat", legacyReady: true });
}

describe("shell", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders the sidebar and the chat region by default", () => {
    render(<Shell onHostsReady={() => {}} />);

    expect(screen.getByText("Enduragent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
    expect(document.querySelector("div.thread")).not.toBeNull();
    expect(document.querySelector("div.composer-wrap")).not.toBeNull();
    expect(document.querySelector('.drawer[aria-label="Training data"]')).not.toBeNull();
  });

  it("hands every legacy host to the boot callback once", () => {
    const onHostsReady = vi.fn<(hosts: LegacyHosts) => void>();

    const { rerender } = render(<Shell onHostsReady={onHostsReady} />);
    rerender(<Shell onHostsReady={onHostsReady} />);

    expect(onHostsReady).toHaveBeenCalledTimes(1);
    const hosts = onHostsReady.mock.calls[0][0];
    expect(hosts.conversation.classList.contains("conversation")).toBe(true);
    expect(hosts.thread.classList.contains("thread")).toBe(true);
    expect(hosts.composerHost.classList.contains("composer-wrap")).toBe(true);
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

  it("keeps the legacy chat hosts mounted while another view is shown", async () => {
    const user = userEvent.setup();
    const onHostsReady = vi.fn<(hosts: LegacyHosts) => void>();
    render(<Shell onHostsReady={onHostsReady} />);
    const thread = onHostsReady.mock.calls[0][0].thread;

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("region", { name: "Settings" });

    expect(thread.isConnected).toBe(true);
    expect(onHostsReady).toHaveBeenCalledTimes(1);
  });

  it("disables the new chat button until the legacy boot has run", () => {
    useEnduragentStore.setState({ legacyReady: false });
    render(<Shell onHostsReady={() => {}} />);

    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("routes the new chat button at the legacy new-conversation control", async () => {
    const user = userEvent.setup();
    render(<Shell onHostsReady={() => {}} />);
    const legacyButton = document.createElement("button");
    legacyButton.type = "button";
    legacyButton.className = "new-conversation-button";
    const clicked = vi.fn();
    legacyButton.addEventListener("click", clicked);
    document.body.append(legacyButton);

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(useEnduragentStore.getState().activeView).toBe("chat");
    legacyButton.remove();
  });
});
