import { useEffect, useRef, type ReactElement } from "react";
import type { DesktopCredentialSlot } from "../../onboarding/constants.js";
import { registerCredentialDraft, releaseCredentialDraft } from "../../state/credential-drafts.js";
import { SETUP_FIELD_CLASS, SETUP_LABEL_CLASS } from "./SetupCard.js";

export function CredentialField(props: {
  readonly slot: DesktopCredentialSlot;
  readonly label: string;
  readonly disabled: boolean;
  readonly describedBy?: string;
  readonly onEnter?: () => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const slot = props.slot;
  const id = `credential-${slot}`;
  const onEnter = props.onEnter;

  useEffect(() => {
    const element = input.current;
    registerCredentialDraft(slot, element);
    return () => {
      releaseCredentialDraft(slot, element);
    };
  }, [slot]);

  return (
    <div>
      <label className={SETUP_LABEL_CLASS} htmlFor={id}>
        {props.label}
      </label>
      <input
        ref={input}
        id={id}
        className={SETUP_FIELD_CLASS}
        type="password"
        autoComplete="off"
        disabled={props.disabled}
        data-slot={slot}
        aria-describedby={props.describedBy}
        onKeyDown={
          onEnter === undefined
            ? undefined
            : (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                onEnter();
              }
        }
      />
    </div>
  );
}
