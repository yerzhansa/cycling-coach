import type { ReactElement } from "react";
import { INTERVALS_GUIDANCE } from "../../onboarding/constants.js";
import {
  credentialSlotStatus,
  type OnboardingActions,
  type OnboardingSurfaceState,
} from "../../onboarding/controller.js";
import { credentialPresentation } from "../../onboarding/credential-presentation.js";
import { CredentialField } from "./CredentialField.js";
import styles from "./OnboardingWizard.module.css";

export function TrainingDataStep(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly disabled: boolean;
}): ReactElement {
  const surface = props.surface;
  const retryable = surface.statuses.some(
    (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
  );

  return (
    <>
      <p className={styles.kicker}>Training data</p>
      <h1 id="onboarding-title" className={styles.title} tabIndex={-1}>
        Bring your riding history
      </h1>
      <p className={`${styles.copy} onboarding-copy`} aria-label={INTERVALS_GUIDANCE}>
        Connect your device platform to intervals.icu <strong>directly</strong>, not via Strava.
      </p>
      <CredentialField
        slot="intervals-icu"
        label="intervals.icu API key"
        status={credentialSlotStatus(surface, "intervals-icu")}
        disabled={surface.wizard.busy}
      />
      {retryable ? (
        <button
          type="button"
          className={styles.textButton}
          disabled={props.disabled}
          onClick={() => {
            props.actions?.retrySavedKeys();
          }}
        >
          Retry saved keys
        </button>
      ) : null}
      <div className={styles.divider}>or import ride files</div>
      <button
        type="button"
        className={styles.dropZone}
        disabled={props.disabled || surface.rideImport.status === "running"}
        onClick={() => {
          props.actions?.chooseImportFiles();
        }}
      >
        <strong>Choose FIT, TCX, or GPX files</strong>
        <span>You can also drop files here.</span>
      </button>
    </>
  );
}
