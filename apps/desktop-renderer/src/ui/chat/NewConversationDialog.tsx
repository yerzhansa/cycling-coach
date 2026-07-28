import { useLayoutEffect, useRef, type ReactElement } from "react";
import { focusNewConversationOpener } from "../../state/new-conversation-opener.js";
import { useEnduragentStore } from "../../state/store.js";

const BASE_COPY =
  "Your visible conversation will be cleared. Your training data and saved coach memory will remain.";
const HYDRATED_COPY =
  "Your visible conversation and the earlier messages restored on this Mac will be cleared. Your training data and saved coach memory will remain.";

export function NewConversationDialog(props: {
  readonly onComposerReset: () => void;
}): ReactElement {
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const resetCount = useEnduragentStore((state) => state.chat.resetCount);
  const hasHydratedHistory = useEnduragentStore((state) => state.chat.hasHydratedHistory);
  const actions = useEnduragentStore((state) => state.chatActions);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const renderedResetCount = useRef(resetCount);
  const onComposerReset = props.onComposerReset;

  const pending = resetPhase === "resetting";
  const requested = resetPhase === "confirming" || pending;

  useLayoutEffect(() => {
    const element = dialog.current;
    const completed = resetCount !== renderedResetCount.current;
    renderedResetCount.current = resetCount;
    if (element === null) return;
    if (requested && !element.open) {
      element.showModal();
      cancel.current?.focus();
      return;
    }
    if (!requested && element.open) {
      element.close();
      if (completed) onComposerReset();
      else focusNewConversationOpener();
      return;
    }
    if (completed) onComposerReset();
  });

  return (
    <dialog
      ref={dialog}
      className="new-conversation-dialog"
      aria-labelledby="new-conversation-title"
      aria-describedby="new-conversation-description"
      aria-modal="true"
      aria-busy={pending ? "true" : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) actions?.cancelNewConversation();
      }}
    >
      <h2 id="new-conversation-title">Start a new conversation?</h2>
      <p id="new-conversation-description">{hasHydratedHistory ? HYDRATED_COPY : BASE_COPY}</p>
      <div className="new-conversation-dialog__actions">
        <button
          type="button"
          ref={cancel}
          disabled={pending}
          onClick={() => {
            actions?.cancelNewConversation();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="new-conversation-dialog__confirm"
          disabled={pending}
          onClick={() => {
            actions?.confirmNewConversation();
          }}
        >
          Start new conversation
        </button>
      </div>
    </dialog>
  );
}
