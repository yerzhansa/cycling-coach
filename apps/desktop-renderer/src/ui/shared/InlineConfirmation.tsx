import { useEffect, useId, useRef, type ReactElement } from "react";

export type InlineConfirmationFocus = "cancel" | "confirm" | null;

function escapeBlockedByActiveElement(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.matches("input, textarea, select") || active.isContentEditable) return true;
  const editingHost = active.closest<HTMLElement>("[contenteditable]");
  return (
    editingHost !== null && editingHost.getAttribute("contenteditable")?.toLowerCase() !== "false"
  );
}

export function InlineConfirmation(props: {
  readonly name: string;
  readonly title: string;
  readonly copy: string;
  readonly confirmLabel: string;
  readonly confirmAriaLabel?: string;
  readonly focusTarget: InlineConfirmationFocus;
  readonly cancelDisabled?: boolean;
  readonly confirmDisabled?: boolean;
  readonly confirmBusy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const focusedOnMount = useRef(false);
  const id = useId();
  const titleId = `${id}-title`;
  const copyId = `${id}-copy`;

  useEffect(() => {
    const target = props.focusTarget ?? (focusedOnMount.current ? null : "cancel");
    focusedOnMount.current = true;
    if (target === "cancel") cancel.current?.focus();
    else if (target === "confirm") confirm.current?.focus();
  }, [props.focusTarget]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== "Escape" ||
        props.cancelDisabled === true ||
        props.confirmBusy === true ||
        escapeBlockedByActiveElement()
      ) {
        return;
      }
      event.preventDefault();
      props.onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.cancelDisabled, props.confirmBusy, props.onCancel]);

  return (
    <div
      className="flex w-full items-start gap-[11px] bg-sunk px-[15px] py-3"
      data-inline-confirmation={props.name}
    >
      <span className="w-[18px] shrink-0" />
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-7 gap-y-3"
        role="group"
        aria-labelledby={titleId}
        aria-describedby={copyId}
      >
        <div className="min-w-52 flex-1">
          <h3 id={titleId} className="m-0 text-[13.5px] font-medium text-ink">
            {props.title}
          </h3>
          <p id={copyId} className="mt-1 mb-0 text-xs text-ink-2">
            {props.copy}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            ref={cancel}
            className="inline-flex h-ctl-sm flex-none items-center justify-center rounded-ctl border border-transparent bg-transparent px-[9px] text-[13px] font-medium whitespace-nowrap text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] hover:text-ink disabled:opacity-50 motion-reduce:transition-none"
            disabled={props.cancelDisabled}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={confirm}
            className="inline-flex h-ctl-sm flex-none items-center justify-center rounded-ctl border border-[color-mix(in_srgb,var(--danger)_34%,transparent)] bg-transparent px-[9px] text-[13px] font-medium whitespace-nowrap text-danger transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] disabled:opacity-50 aria-disabled:opacity-50 motion-reduce:transition-none"
            disabled={props.confirmBusy ? false : props.confirmDisabled}
            aria-disabled={props.confirmBusy ? "true" : undefined}
            aria-label={props.confirmAriaLabel}
            onClick={() => {
              if (!props.confirmBusy) props.onConfirm();
            }}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
