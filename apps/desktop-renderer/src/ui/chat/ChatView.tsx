import { useEffect, useLayoutEffect, useRef, type ReactElement } from "react";
import { CHAT_AUTO_LOAD_EARLIER_THRESHOLD, chatScrollAnchor } from "../../state/chat-stream.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./ChatView.module.css";
import { Composer, type ComposerHandle } from "./Composer.js";
import { FirstSyncCard } from "./FirstSyncCard.js";
import { NewConversationDialog } from "./NewConversationDialog.js";
import { QueuedMessages } from "./QueuedMessages.js";
import { QuickActions } from "./QuickActions.js";
import { SpendNotice } from "./SpendNotice.js";
import { Transcript } from "./Transcript.js";

const COMPOSER_CLEARANCE_PROPERTY = "--chat-composer-clearance";

function FollowLatest(): null {
  const surface = useEnduragentStore((state) => state.chat);
  const appliedRevision = useRef(0);

  useLayoutEffect(() => {
    const hydrationChanged = surface.hydrationRevision !== appliedRevision.current;
    appliedRevision.current = surface.hydrationRevision;
    chatScrollAnchor.apply({ hydrationChanged, hydrationChange: surface.hydrationChange });
  });

  return null;
}

export function ChatView(): ReactElement {
  const conversation = useRef<HTMLElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const activeView = useEnduragentStore((state) => state.activeView);
  const status = useEnduragentStore((state) => state.chat.status);
  const announcement = useEnduragentStore((state) => state.chat.announcement);
  const hydrationStatus = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);
  const mountedView = useRef(activeView);

  useLayoutEffect(() => {
    chatScrollAnchor.attach(conversation.current);
    return () => {
      chatScrollAnchor.attach(null);
    };
  }, []);

  useLayoutEffect(() => {
    const host = composerWrap.current;
    const target = conversation.current;
    if (host === null || target === null) return;
    const update = (): void => {
      const height = host.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0) {
        target.style.setProperty(COMPOSER_CLEARANCE_PROPERTY, `${height}px`);
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => {
      observer.disconnect();
      target.style.removeProperty(COMPOSER_CLEARANCE_PROPERTY);
    };
  }, []);

  useLayoutEffect(() => {
    if (activeView !== "chat") return;
    chatScrollAnchor.reanchor();
  }, [activeView]);

  useEffect(() => {
    if (mountedView.current === "chat") composer.current?.focus();
  }, []);

  useEffect(() => {
    const target = conversation.current;
    if (target === null) return;
    const onScroll = (): void => {
      if (target.offsetParent === null) return;
      if (
        target.scrollTop <= CHAT_AUTO_LOAD_EARLIER_THRESHOLD &&
        hasEarlier &&
        hydrationStatus !== "loading" &&
        hydrationStatus !== "failed" &&
        !workBlocked
      ) {
        actions?.loadEarlier();
      }
    };
    target.addEventListener("scroll", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
    };
  }, [actions, hasEarlier, hydrationStatus, workBlocked]);

  return (
    <>
      <main
        className={`${styles.conversation} conversation`}
        aria-label="Coaching conversation"
        data-chat-status={status}
        ref={conversation}
      >
        <div className={`${styles.thread} thread`}>
          <Transcript />
          <FirstSyncCard />
        </div>
      </main>
      <div className={`${styles.composerWrap} composer-wrap`} ref={composerWrap}>
        <div className={`${styles.noticeHost} chat-notice-host`}>
          <p
            className={`${styles.announcement} new-conversation-status`}
            role="status"
            aria-live="polite"
          >
            {announcement ?? ""}
          </p>
          <SpendNotice />
        </div>
        <QuickActions />
        <QueuedMessages />
        <Composer handle={composer} />
      </div>
      <NewConversationDialog
        onComposerReset={() => {
          composer.current?.reset();
        }}
      />
      <FollowLatest />
    </>
  );
}
