import {
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { filterSlashCommands } from "../../chat/commands.js";
import { Button } from "../../components/ui/button.js";
import { useEnduragentStore } from "../../state/store.js";
import { setupReady } from "../../state/onboarding-slice.js";
import { SlashPopup } from "./SlashPopup.js";

export interface ComposerHandle {
  focus(): void;
  reset(): void;
}

export function Composer(props: {
  readonly handle: RefObject<ComposerHandle | null>;
  readonly hidden?: boolean;
}): ReactElement {
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listboxId = useId();
  const sendDisabled = useEnduragentStore((state) => state.chat.sendDisabled);
  const inputDisabled = useEnduragentStore((state) => state.chat.inputDisabled);
  const status = useEnduragentStore((state) => state.chat.status);
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);

  const matches = useMemo(() => filterSlashCommands(draft), [draft]);
  const open = matches.length > 0 && !dismissed;
  const active = selected < matches.length ? selected : 0;

  useImperativeHandle(
    props.handle,
    () => ({
      focus() {
        textarea.current?.focus();
      },
      reset() {
        const input = textarea.current;
        if (input !== null) {
          input.value = "";
          input.focus();
        }
        setDraft("");
        setSelected(0);
        setDismissed(false);
      },
    }),
    [],
  );

  const submit = (): void => {
    const input = textarea.current;
    if (input === null || sendDisabled || !canChat) return;
    const value = input.value;
    if (!/\S/u.test(value)) return;
    input.value = "";
    setDraft("");
    setSelected(0);
    setDismissed(false);
    actions?.submit(value);
  };

  const accept = (index: number): void => {
    const match = matches[index];
    const input = textarea.current;
    if (match === undefined || input === null) return;
    const inserted = `${match.command} `;
    input.value = inserted;
    setDraft(inserted);
    setSelected(0);
    setDismissed(false);
    input.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((active + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((active + matches.length - 1) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(active);
        return;
      }
      if (event.key === "Escape") setDismissed(true);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      ref={form}
      className="composer relative"
      hidden={props.hidden}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SlashPopup
        open={open}
        anchor={form}
        listboxId={listboxId}
        matches={matches}
        selected={active}
        onHighlight={setSelected}
        onAccept={accept}
        onDismiss={() => {
          setDismissed(true);
        }}
      />
      <label className="sr-only" htmlFor="message">
        Message your coach
      </label>
      <div className="chat-composer__controls grid grid-rows-[minmax(var(--ctl-h-lg),auto)_var(--ctl-h-lg)] gap-[calc(var(--inset)/2)] rounded-card border border-line-2 bg-surface pt-row pr-ctl-px pb-row pl-[calc(var(--inset)*2)] shadow-elev-2 transition-[border-color,box-shadow] duration-120 motion-reduce:transition-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
        <textarea
          id="message"
          ref={textarea}
          className="min-h-10 max-h-[140px] w-full resize-none border-0 bg-transparent py-[3px] text-sm text-ink outline-0 placeholder:text-ink-3 focus-visible:outline-0"
          rows={2}
          placeholder={status === "streaming" ? "Coach is responding…" : "Message your coach"}
          disabled={inputDisabled || !canChat}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open ? `${listboxId}-option-${active}` : undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setSelected(0);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setDismissed(true);
          }}
        />
        <div className="chat-composer__toolbar flex items-center justify-end">
          {status === "streaming" ? (
            <Button
              type="button"
              variant="default"
              size="icon-lg"
              aria-label="Stop responding"
              disabled={actions === null}
              onClick={() => {
                actions?.stop();
              }}
            >
              <Square className="size-2.5 fill-current stroke-none" aria-hidden="true" />
            </Button>
          ) : (
            <Button
              type="submit"
              variant="default"
              size="icon-lg"
              aria-label="Send message"
              disabled={sendDisabled || !canChat}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
