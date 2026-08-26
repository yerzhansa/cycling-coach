import {
  useImperativeHandle,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
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
  const [submitting, setSubmitting] = useState(false);
  const restoredRevision = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listboxId = useId();
  const sendDisabled = useEnduragentStore((state) => state.chat.sendDisabled);
  const inputDisabled = useEnduragentStore((state) => state.chat.inputDisabled);
  const status = useEnduragentStore((state) => state.chat.status);
  const actions = useEnduragentStore((state) => state.chatActions);
  const canChat = useEnduragentStore(setupReady);
  const attachmentSurface = useEnduragentStore((state) => state.chat.attachments);
  const attachmentIds =
    attachmentSurface?.draft?.attachments.map((attachment) => attachment.attachmentId) ?? [];

  const matches = useMemo(() => filterSlashCommands(draft), [draft]);
  const open = matches.length > 0 && !dismissed;
  const active = selected < matches.length ? selected : 0;

  useEffect(() => {
    const restored = attachmentSurface?.draft;
    if (restored === undefined || restored === null) return;
    const revision = `${restored.updatedAt}:${restored.text}`;
    if (restoredRevision.current === revision) return;
    restoredRevision.current = revision;
    const input = textarea.current;
    if (input === null || input.value === restored.text) return;
    if (input.value.length > 0 && restored.state !== "restored") return;
    input.value = restored.text;
    setDraft(restored.text);
  }, [attachmentSurface]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
  );

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

  const submit = async (): Promise<void> => {
    const input = textarea.current;
    if (input === null || sendDisabled || submitting || !canChat || actions === null) return;
    const value = input.value;
    if (!/\S/u.test(value) && attachmentIds.length === 0) return;
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    actions.saveAttachmentDraftText(value);
    setSubmitting(true);
    try {
      const acknowledged =
        attachmentIds.length === 0
          ? await actions.submit(value)
          : await actions.submit(value, attachmentIds);
      if (!acknowledged) return;
      if (input.value === value) {
        input.value = "";
        setDraft("");
        setSelected(0);
        setDismissed(false);
      }
    } catch {
      input.focus();
    } finally {
      setSubmitting(false);
    }
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
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"))) {
      return;
    }
    event.preventDefault();
    void actions?.pasteAttachment();
  };

  return (
    <form
      ref={form}
      className="composer relative"
      data-chat-attachment-dropzone="true"
      hidden={props.hidden}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
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
            const value = event.currentTarget.value;
            setDraft(value);
            setSelected(0);
            setDismissed(false);
            if (saveTimer.current !== null) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              actions?.saveAttachmentDraftText(value);
            }, 300);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            setDismissed(true);
          }}
        />
        <div className="chat-composer__toolbar flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Attach files"
            disabled={actions === null || inputDisabled || !canChat || attachmentSurface === null}
            onClick={() => void actions?.chooseAttachments()}
          >
            <Paperclip aria-hidden="true" />
          </Button>
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
              disabled={sendDisabled || submitting || !canChat}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
