import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { filterSlashCommands } from "../../chat/commands.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Composer.module.css";
import { SlashPopup } from "./SlashPopup.js";

export interface ComposerHandle {
  reset(): void;
}

export function Composer(props: {
  readonly handle: RefObject<ComposerHandle | null>;
}): ReactElement {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const sendDisabled = useEnduragentStore((state) => state.chat.sendDisabled);
  const inputDisabled = useEnduragentStore((state) => state.chat.inputDisabled);
  const actions = useEnduragentStore((state) => state.chatActions);

  const matches = useMemo(() => filterSlashCommands(draft), [draft]);
  const open = matches.length > 0 && !dismissed;
  const active = selected < matches.length ? selected : 0;

  useImperativeHandle(
    props.handle,
    () => ({
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
    if (input === null || sendDisabled) return;
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
      className={`composer ${styles.form}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SlashPopup
        open={open}
        matches={matches}
        selected={active}
        onHighlight={setSelected}
        onAccept={accept}
      />
      <label className={`${styles.label} chat-composer__label`} htmlFor="message">
        Message your coach
      </label>
      <div className={`${styles.controls} chat-composer__controls`}>
        <textarea
          id="message"
          ref={textarea}
          rows={2}
          disabled={inputDisabled}
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
        <button type="submit" aria-label="Send message" disabled={sendDisabled}>
          ↑
        </button>
      </div>
    </form>
  );
}
