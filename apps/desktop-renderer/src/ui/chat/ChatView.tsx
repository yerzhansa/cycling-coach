import { useEffect, useLayoutEffect, useRef, type ReactElement, type RefObject } from "react";
import {
  CHAT_AUTO_LOAD_EARLIER_THRESHOLD,
  chatScrollAnchor,
} from "../../state/chat-stream.js";
import { useEnduragentStore } from "../../state/store.js";
import { Composer, type ComposerHandle } from "./Composer.js";
import { FirstSyncCard } from "./FirstSyncCard.js";
import { NewConversationDialog } from "./NewConversationDialog.js";
import { QuickActions } from "./QuickActions.js";
import { Transcript } from "./Transcript.js";

const COMPOSER_CLEARANCE_PROPERTY = "--chat-composer-clearance";

export function ChatView(props: {
  readonly noticeHostRef: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const conversation = useRef<HTMLElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const appliedRevision = useRef(0);
  const status = useEnduragentStore((state) => state.chat.status);
  const announcement = useEnduragentStore((state) => state.chat.announcement);
  const hydrationRevision = useEnduragentStore((state) => state.chat.hydrationRevision);
  const hydrationChange = useEnduragentStore((state) => state.chat.hydrationChange);
  const hydrationStatus = useEnduragentStore((state) => state.chat.hydrationStatus);
  const hasEarlier = useEnduragentStore((state) => state.chat.hydrationHasEarlier);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

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

  useEffect(() => {
    const target = conversation.current;
    if (target === null) return;
    const onScroll = (): void => {
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

  useLayoutEffect(() => {
    const hydrationChanged = hydrationRevision !== appliedRevision.current;
    appliedRevision.current = hydrationRevision;
    chatScrollAnchor.apply({ hydrationChanged, hydrationChange });
  });

  return (
    <>
      <main
        className="conversation desktop-shell"
        aria-label="Coaching conversation"
        data-chat-status={status}
        ref={conversation}
      >
        <div className="thread">
          <Transcript />
          <FirstSyncCard />
        </div>
      </main>
      <div className="composer-wrap" ref={composerWrap}>
        <div className="chat-notice-host">
          <p className="new-conversation-status" role="status" aria-live="polite">
            {announcement ?? ""}
          </p>
          <div className="chat-notice-host__slot" ref={props.noticeHostRef} />
        </div>
        <QuickActions />
        <Composer handle={composer} />
      </div>
      <NewConversationDialog
        onComposerReset={() => {
          composer.current?.reset();
        }}
      />
    </>
  );
}
