import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { useEnduragentStore } from "../../state/store.js";

export function Notice(): ReactElement {
  const notice = useEnduragentStore((state) => state.chat.notice);
  return (
    <p className="chat-notice m-0 text-sm text-ink-2" hidden={notice === null}>
      {notice ?? ""}
    </p>
  );
}

export function RetryBar(): ReactElement {
  const interrupted = useEnduragentStore((state) => state.chat.interrupted);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);

  return (
    <Button
      type="button"
      className="chat-retry justify-self-start"
      variant="outline"
      size="sm"
      hidden={!interrupted}
      disabled={workBlocked}
      onClick={() => {
        if (!interrupted || workBlocked) return;
        actions?.retry();
      }}
    >
      Retry message
    </Button>
  );
}
