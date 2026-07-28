import { useEffect, useLayoutEffect, useRef, type ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";

const COACHING_SHORTCUTS = Object.freeze([
  Object.freeze({ command: "/plan", label: "Build a plan" }),
  Object.freeze({ command: "/workout", label: "Today’s workout" }),
  Object.freeze({ command: "/status", label: "Training status" }),
  Object.freeze({ command: "/review", label: "Review last session" }),
]);

interface PendingFocus {
  readonly button: HTMLButtonElement;
  observedTurnLock: boolean;
}

function displaced(target: EventTarget | null, button: HTMLButtonElement): boolean {
  return target !== button && target !== document.body && target !== document.documentElement;
}

function reclaimable(button: HTMLButtonElement): boolean {
  const active = document.activeElement;
  return (
    active !== button &&
    (active === null || active === document.body || active === document.documentElement)
  );
}

export function QuickActions(): ReactElement {
  const disabled = useEnduragentStore((state) => state.chat.composerDisabled);
  const resetPhase = useEnduragentStore((state) => state.chat.resetPhase);
  const resetCount = useEnduragentStore((state) => state.chat.resetCount);
  const actions = useEnduragentStore((state) => state.chatActions);
  const pending = useRef<PendingFocus | undefined>(undefined);
  const renderedResetCount = useRef(resetCount);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const current = pending.current;
      if (current !== undefined && displaced(event.target, current.button)) {
        pending.current = undefined;
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  useLayoutEffect(() => {
    const current = pending.current;
    const completed = resetCount !== renderedResetCount.current;
    renderedResetCount.current = resetCount;
    if (current === undefined) return;
    if (resetPhase !== "idle" || completed) {
      pending.current = undefined;
      return;
    }
    if (disabled) {
      current.observedTurnLock = true;
      return;
    }
    if (!current.observedTurnLock) return;
    pending.current = undefined;
    if (reclaimable(current.button)) current.button.focus();
  });

  return (
    <div className="coaching-shortcuts" role="group" aria-label="Coaching shortcuts">
      {COACHING_SHORTCUTS.map((shortcut) => (
        <button
          key={shortcut.command}
          type="button"
          className="coaching-shortcut"
          aria-label={`${shortcut.label}, ${shortcut.command} command`}
          disabled={disabled}
          onClick={(event) => {
            if (disabled || actions === null) return;
            const button = event.currentTarget;
            pending.current =
              event.detail === 0 && document.activeElement === button
                ? { button, observedTurnLock: false }
                : undefined;
            actions.submit(shortcut.command);
          }}
        >
          <span className="coaching-shortcut__label">{shortcut.label}</span>
          <span className="coaching-shortcut__command">{shortcut.command}</span>
        </button>
      ))}
    </div>
  );
}
