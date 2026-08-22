import type { ReactElement } from "react";
import { XIcon } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { useEnduragentStore } from "../../state/store.js";
import { setupReady } from "../../state/onboarding-slice.js";

export function QueuedMessages(): ReactElement | null {
  const queued = useEnduragentStore((state) => state.chat.queued);
  const workBlocked = useEnduragentStore((state) => state.chat.workBlocked);
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);

  if (queued.length === 0) return null;

  return (
    <section className="chat-queue mb-2.5 min-w-0" aria-label="Queued messages">
      <p className="chat-queue__caption m-0 mb-1.5 ml-3.5 text-xs font-medium text-ink-2">
        Queued to send next
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0" role="list">
        {queued.map((message, index) => (
          <li
            key={message.id}
            className="chat-queue__item flex min-w-0 items-center gap-2 rounded-ctl border border-line bg-sunk py-[5px] pr-[5px] pl-3.5"
          >
            <span
              className={cn(
                "chat-queue__text min-w-0 flex-1 truncate text-sm text-ink-2",
                message.command && "chat-queue__command font-medium",
              )}
            >
              {message.text}
            </span>
            <Button
              className="chat-queue__remove text-ink-2 hover:text-ink"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove queued message ${index + 1}`}
              disabled={!canChat || workBlocked || actions === null}
              onClick={() => {
                actions?.removeQueued(message.id);
              }}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
