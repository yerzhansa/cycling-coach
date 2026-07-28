import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell.js";
import {
  EMPTY_CHAT_SURFACE,
  type ChatActions,
  type ChatMessageView,
  type ChatSurfaceState,
} from "../src/state/chat-slice.js";
import { resetChatStream } from "../src/state/chat-stream.js";
import { useEnduragentStore } from "../src/state/store.js";
import { ChatView } from "../src/ui/chat/ChatView.js";
import { SLASH_COMMANDS } from "../src/ui/chat/commands.js";
import transcriptStyles from "../src/ui/chat/Transcript.module.css";

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

function setChat(patch: Partial<ChatSurfaceState>): void {
  act(() => {
    useEnduragentStore.setState({ chat: { ...useEnduragentStore.getState().chat, ...patch } });
  });
}

function Harness(): ReactElement {
  const noticeHost = useRef<HTMLDivElement>(null);
  return <ChatView noticeHostRef={noticeHost} />;
}

function composer(): HTMLTextAreaElement {
  const element = document.querySelector("textarea#message");
  if (!(element instanceof HTMLTextAreaElement)) throw new TypeError("composer missing");
  return element;
}

let actions: ChatActions;

describe("chat surface", () => {
  beforeEach(() => {
    actions = stubActions();
    useEnduragentStore.setState({
      activeView: "chat",
      legacyReady: true,
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: actions,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: null,
    });
    resetChatStream();
  });

  describe("slash popup", () => {
    it("filters as the athlete types after a slash", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/");
      expect(screen.getAllByRole("option")).toHaveLength(SLASH_COMMANDS.length);

      await user.keyboard("st");
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "/startStart a fresh session",
        "/statusCheck current fitness, fatigue, and form",
      ]);

      await user.keyboard("zz");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("closes once the draft carries whitespace", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/plan");
      expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();

      await user.keyboard(" ");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("moves the selection with the arrow keys and accepts with Enter", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/st");
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowDown}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowUp}{ArrowUp}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{Enter}");
      expect(composer()).toHaveValue("/status ");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(actions.submit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(composer());
    });

    it("accepts a command on click without sending it", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/rev");
      await user.click(screen.getByRole("option", { name: /\/review/u }));

      expect(composer()).toHaveValue("/review ");
      expect(actions.submit).not.toHaveBeenCalled();
    });

    it("closes on Escape and keeps the draft", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/pl");
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("listbox")).toBeNull();
      expect(composer()).toHaveValue("/pl");
    });
  });

  describe("composer", () => {
    it("never submits while an IME composition is in flight", async () => {
      render(<Harness />);
      const textarea = composer();
      const draft = "回復走を";
      textarea.focus();
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      act(() => {
        textarea.value = draft;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const composing = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        textarea.dispatchEvent(composing);
      });

      expect(composing.defaultPrevented).toBe(false);
      expect(actions.submit).not.toHaveBeenCalled();
      expect(textarea).toHaveValue(draft);
      expect(document.activeElement).toBe(textarea);

      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      const committed = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        textarea.dispatchEvent(committed);
      });

      expect(committed.defaultPrevented).toBe(true);
      expect(actions.submit).toHaveBeenCalledWith(draft);
      expect(textarea).toHaveValue("");
    });

    it("keeps Shift+Enter as a newline and ignores blank drafts", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("first{Shift>}{Enter}{/Shift}second");
      expect(composer()).toHaveValue("first\nsecond");
      expect(actions.submit).not.toHaveBeenCalled();

      await user.clear(composer());
      await user.keyboard("   {Enter}");
      expect(actions.submit).not.toHaveBeenCalled();

      await user.keyboard("ride{Enter}");
      expect(actions.submit).toHaveBeenCalledWith("   ride");
    });

    it("locks the composer and the quick actions while a turn is in flight", () => {
      render(<Harness />);
      setChat({ composerDisabled: true });

      expect(composer()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      for (const button of screen.getAllByRole("button", { name: /command$/u })) {
        expect(button).toBeDisabled();
      }
    });

    it("restores focus to a keyboard-activated quick action once the turn settles", async () => {
      render(<Harness />);
      const shortcut = screen.getByRole("button", { name: "Training status, /status command" });
      shortcut.focus();

      act(() => {
        shortcut.click();
      });
      expect(actions.submit).toHaveBeenCalledWith("/status");

      setChat({ composerDisabled: true });
      act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      setChat({ composerDisabled: false });

      await waitFor(() => {
        expect(document.activeElement).toBe(shortcut);
      });
    });
  });

  describe("hydration controls", () => {
    it("offers load-earlier only while earlier pages remain", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const load = document.querySelector(".chat-history-load");
      const controls = document.querySelector(".chat-history-controls");
      if (!(load instanceof HTMLButtonElement) || !(controls instanceof HTMLElement)) {
        throw new TypeError("history controls missing");
      }

      expect(controls.hidden).toBe(true);
      expect(load.hidden).toBe(true);

      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      expect(controls.hidden).toBe(false);
      expect(load.hidden).toBe(false);
      await user.click(load);
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);

      setChat({ hydrationStatus: "loading" });
      expect(load).toBeDisabled();

      setChat({ hydrationStatus: "ready", workBlocked: true });
      expect(load).toBeDisabled();
    });

    it("swaps to the failure copy and a retry control when history is unavailable", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "failed" });

      const load = document.querySelector(".chat-history-load");
      const failure = document.querySelector(".chat-history-failure");
      const retry = document.querySelector(".chat-history-retry");
      if (
        !(load instanceof HTMLButtonElement) ||
        !(failure instanceof HTMLElement) ||
        !(retry instanceof HTMLButtonElement)
      ) {
        throw new TypeError("history controls missing");
      }

      expect(load.hidden).toBe(true);
      expect(failure.hidden).toBe(false);
      expect(failure.textContent).toBe("Conversation history is temporarily unavailable.");
      expect(retry.hidden).toBe(false);

      await user.click(retry);
      expect(actions.retryHydration).toHaveBeenCalledTimes(1);
    });

    it("auto-loads earlier pages when the transcript is scrolled to the top", () => {
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      const conversation = document.querySelector(".conversation");
      if (!(conversation instanceof HTMLElement)) throw new TypeError("conversation missing");

      conversation.scrollTop = 0;
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);

      setChat({ hydrationStatus: "loading" });
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);
    });
  });

  describe("new conversation dialog", () => {
    it("walks the confirm flow and hands focus back to the composer", async () => {
      const user = userEvent.setup();
      render(<Shell onHostsReady={() => {}} />);
      const dialog = document.querySelector(".new-conversation-dialog");
      if (!(dialog instanceof HTMLDialogElement)) throw new TypeError("dialog missing");
      expect(dialog.open).toBe(false);

      setChat({ resetPhase: "confirming" });
      expect(dialog.open).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

      await user.click(screen.getByRole("button", { name: "Start new conversation" }));
      expect(actions.confirmNewConversation).toHaveBeenCalledTimes(1);

      setChat({ resetPhase: "resetting" });
      expect(dialog.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Start new conversation" })).toBeDisabled();

      composer().value = "leftover draft";
      setChat({ resetPhase: "idle", resetCount: 1 });
      expect(dialog.open).toBe(false);
      expect(composer()).toHaveValue("");
      expect(document.activeElement).toBe(composer());
    });

    it("returns focus to the opener when the athlete cancels", async () => {
      const user = userEvent.setup();
      useEnduragentStore.setState({
        chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
      });
      render(<Shell onHostsReady={() => {}} />);

      setChat({ resetPhase: "confirming" });
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(actions.cancelNewConversation).toHaveBeenCalledTimes(1);

      setChat({ resetPhase: "idle" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "New chat" }));
    });

    it("names the restored history in the confirmation copy", () => {
      render(<Harness />);
      setChat({ resetPhase: "confirming" });
      expect(screen.getByText(/Your visible conversation will be cleared\./u)).toBeInTheDocument();

      setChat({ hasHydratedHistory: true });
      expect(
        screen.getByText(/earlier messages restored on this Mac will be cleared/u),
      ).toBeInTheDocument();
    });
  });

  describe("first sync card", () => {
    it("shows nothing until the first sync is under way", () => {
      render(<Harness />);
      expect(document.querySelector(".first-sync")).toBeNull();

      act(() => {
        useEnduragentStore.setState({ firstSync: { status: "syncing" } });
      });
      expect(screen.getByRole("progressbar", { name: "Syncing training history" })).toBeVisible();

      act(() => {
        useEnduragentStore.setState({ firstSync: { status: "ready" } });
      });
      expect(document.querySelector(".first-sync")).toBeNull();
    });

    it("retries a recoverable sync failure and refuses one that needs a relaunch", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      act(() => {
        useEnduragentStore.setState({
          firstSync: { status: "failed", kind: "operation", retryable: true },
        });
      });

      const retry = screen.getByRole("button", { name: "Retry sync" });
      await user.click(retry);
      expect(actions.retryFirstSync).toHaveBeenCalledTimes(1);
      expect(retry).toBeDisabled();

      act(() => {
        useEnduragentStore.setState({
          firstSync: { status: "failed", kind: "protocol", retryable: false },
        });
      });
      expect(screen.queryByRole("button", { name: "Retry sync" })).toBeNull();
      expect(screen.getByText("Quit and reopen Enduragent.")).toBeInTheDocument();
    });
  });

  describe("coach prose", () => {
    function message(patch: Partial<ChatMessageView> & { readonly id: string }): ChatMessageView {
      return {
        role: "coach",
        delivery: "complete",
        historical: false,
        text: "Ride steady on Tuesday.",
        ...patch,
      };
    }

    it("sets the prose face on every coach turn and leaves athlete turns on the interface face", () => {
      render(<Harness />);
      setChat({
        messages: [
          message({ id: "a1", role: "athlete", text: "Plan my week" }),
          message({ id: "c1", delivery: "streaming", text: "Ride " }),
          message({ id: "c2" }),
          message({ id: "c3", historical: true, text: "Nice work last week." }),
        ],
      });

      for (const id of ["c1", "c2", "c3"]) {
        const row = document.querySelector(`[data-message-id="${id}"]`);
        expect(row?.classList.contains(transcriptStyles.prose)).toBe(true);
      }
      const athlete = document.querySelector('[data-message-id="a1"]');
      expect(athlete?.classList.contains(transcriptStyles.prose)).toBe(false);
      expect(athlete?.classList.contains("chat-message--athlete")).toBe(true);
    });

    it("keeps the prose face on the row so streaming text never reflows when the turn settles", () => {
      render(<Harness />);
      setChat({ messages: [message({ id: "c1", delivery: "streaming", text: "Ride " })] });
      const row = document.querySelector('[data-message-id="c1"]');
      const streamingClassName = row?.className;

      setChat({ messages: [message({ id: "c1" })] });
      expect(document.querySelector('[data-message-id="c1"]')).toBe(row);
      expect(row?.className).toBe(streamingClassName);
    });

    it("declares the bundled prose face for the transcript row", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src");
      const [stylesheet, tokens] = await Promise.all([
        readFile(resolve(sourceRoot, "ui/chat/Transcript.module.css"), "utf8"),
        readFile(resolve(sourceRoot, "theme/tokens.css"), "utf8"),
      ]);
      expect(stylesheet).toMatch(/\.prose\s*\{[^}]*font:\s*16px\/1\.6\s+var\(--f-prose\);/u);
      expect(tokens).toMatch(/--f-prose:\s*"Source Serif 4 Variable"/u);
    });
  });
});
