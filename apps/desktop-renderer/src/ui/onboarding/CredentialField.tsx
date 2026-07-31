import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import type { DesktopCredentialSlot } from "../../onboarding/constants.js";
import { credentialPresentation } from "../../onboarding/credential-presentation.js";
import type { CredentialSlotStatus } from "../../onboarding/machine.js";
import { registerCredentialDraft, releaseCredentialDraft } from "../../state/credential-drafts.js";
import styles from "./OnboardingWizard.module.css";

function CredentialBadge(props: { readonly status: CredentialSlotStatus }): ReactElement {
  const presentation = credentialPresentation(props.status);
  return (
    <span
      className={`${styles.badge} credential-state`}
      data-state={presentation.className === "" ? "missing" : presentation.className}
    >
      {presentation.copy}
    </span>
  );
}

export function CredentialField(props: {
  readonly slot: DesktopCredentialSlot;
  readonly label: string;
  readonly status: CredentialSlotStatus;
  readonly disabled: boolean;
  readonly hint?: ReactNode;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const slot = props.slot;
  const id = `credential-${slot}`;

  useEffect(() => {
    const element = input.current;
    registerCredentialDraft(slot, element);
    return () => {
      releaseCredentialDraft(slot, element);
    };
  }, [slot]);

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {props.label}
        <CredentialBadge status={props.status} />
        {props.hint === undefined ? null : <span className={styles.hint}>{props.hint}</span>}
      </label>
      <input
        ref={input}
        id={id}
        className={styles.input}
        type="password"
        autoComplete="off"
        disabled={props.disabled}
        data-slot={slot}
        aria-describedby="onboarding-error"
      />
    </div>
  );
}
