import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "../src/state/connection-slice.js";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice.js";
import { restoreManualSyncFocus, setManualSyncFocusTarget } from "../src/state/manual-sync-focus.js";
import { focusSetupOpener } from "../src/state/setup-opener.js";
import { useEnduragentStore } from "../src/state/store.js";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice.js";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice.js";
import { toManualSyncViewState } from "../src/training-context/manual-sync.js";
import { Sidebar } from "../src/ui/sidebar/Sidebar.js";

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

function update(patch: Partial<Parameters<typeof useEnduragentStore.setState>[0]>): void {
  act(() => {
    useEnduragentStore.setState(patch);
  });
}

function chip(): HTMLElement {
  const element = document.querySelector("button.sync-chip");
  if (!(element instanceof HTMLElement)) throw new TypeError("sync chip missing");
  return element;
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
    chatActions: stubActions(),
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    connection: "connecting",
  });
});

afterEach(() => {
  setManualSyncFocusTarget(null);
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    connection: "connecting",
  });
});

describe("sidebar sync chip", () => {
  it("walks the loading, synced, syncing and attention states", () => {
    render(<Sidebar />);

    expect(chip()).toHaveAttribute("data-status", "loading");
    expect(chip()).toHaveTextContent("Loading training data");

    update({
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "fresh",
          degraded: false,
        },
      },
    });
    expect(chip()).toHaveAttribute("data-status", "synced");
    expect(chip()).toHaveTextContent("1998-07-19 07:55:00 UTC");

    update({ sync: toManualSyncViewState({ status: "running", operation: 1 }) });
    expect(chip()).toHaveAttribute("data-status", "syncing");
    expect(chip()).toBeDisabled();

    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "partial",
        retryable: true,
      }),
    });
    expect(chip()).toHaveAttribute("data-status", "attention");
    expect(chip()).toHaveTextContent("Try again");
  });

  it("reports never-synced and unavailable training data honestly", () => {
    render(<Sidebar />);

    update({ training: { ...EMPTY_TRAINING_SURFACE, status: "ready" } });
    expect(chip()).toHaveAttribute("data-status", "never");
    expect(chip()).toHaveTextContent("Not synced yet");

    update({ training: { ...EMPTY_TRAINING_SURFACE, status: "unavailable" } });
    expect(chip()).toHaveAttribute("data-status", "unavailable");
    expect(chip()).toHaveTextContent("Training data unavailable");
  });

  it("requests a manual sync and restores keyboard focus to the activator", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<Sidebar />);

    await user.click(chip());
    expect(request).toHaveBeenNthCalledWith(1, "pointer");
    act(() => {
      chip().blur();
    });
    restoreManualSyncFocus();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(chip());
    expect(request).toHaveBeenNthCalledWith(2, "keyboard");
    restoreManualSyncFocus();
    expect(document.activeElement).toBe(chip());
  });

  it("stays inert until the sync controller is bound", () => {
    render(<Sidebar />);

    expect(chip()).toBeDisabled();
  });
});

describe("sidebar conversations", () => {
  it("lists the single live conversation and says so", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({ activeView: "settings" });
    render(<Sidebar />);

    const entry = screen.getByRole("button", { name: /Current conversation/u });
    expect(entry).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Enduragent keeps one conversation on this Mac.")).toBeInTheDocument();

    await user.click(entry);
    expect(useEnduragentStore.getState().activeView).toBe("chat");
  });
});

describe("sidebar connection status", () => {
  it("names each connection state at the sidebar foot", () => {
    render(<Sidebar />);

    const status = document.querySelector(".connection-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("Connecting…");

    const expected: readonly [ConnectionStatus, string, string][] = [
      ["ready", "Connected", "connected"],
      ["connected", "Connected", "connected"],
      ["recovering", "Reconnecting…", "recovering"],
      ["terminal", "Connection unavailable", "unavailable"],
      ["failed", "Connection unavailable", "unavailable"],
      ["closing", "Closing…", "pending"],
    ];
    for (const [connection, copy, tone] of expected) {
      update({ connection });
      expect(status).toHaveTextContent(copy);
      expect(status).toHaveAttribute("data-tone", tone);
    }
  });
});

describe("sidebar setup opener", () => {
  it("hands setup focus back to the settings destination", () => {
    render(<Sidebar />);

    focusSetupOpener();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Settings/u }));
  });
});
