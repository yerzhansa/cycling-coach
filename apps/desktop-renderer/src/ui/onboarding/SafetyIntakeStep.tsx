import type { ReactElement } from "react";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller.js";
import styles from "./OnboardingWizard.module.css";

const INJURY_OPTIONS = [
  ["none", "No current injury"],
  ["managing", "Managing an injury"],
  ["returning", "Returning after an injury"],
] as const;

function Radio(props: {
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <label className={styles.radio}>
      <input
        type="radio"
        name={props.name}
        checked={props.checked}
        aria-describedby="onboarding-error"
        onChange={props.onSelect}
      />
      {props.label}
    </label>
  );
}

export function SafetyIntakeStep(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
}): ReactElement {
  const intake = props.surface.wizard.intake;
  const actions = props.actions;
  const needsClearance =
    intake.priorBsi === true || (intake.injuryStatus !== null && intake.injuryStatus !== "none");

  return (
    <>
      <p className={styles.kicker}>Safety intake</p>
      <h2 id="onboarding-title" className={styles.title} tabIndex={-1}>
        A few safety checks
      </h2>
      <p className={`${styles.copy} onboarding-copy`}>
        These answers record context for your coach. They are not a diagnosis.
      </p>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Have you had a bone stress injury?</legend>
        {([true, false] as const).map((value) => (
          <Radio
            key={String(value)}
            name="prior-bsi"
            label={value ? "Yes" : "No"}
            checked={intake.priorBsi === value}
            onSelect={() => {
              actions?.setIntake("priorBsi", value);
            }}
          />
        ))}
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>What is your current injury status?</legend>
        {INJURY_OPTIONS.map(([value, label]) => (
          <Radio
            key={value}
            name="injury-status"
            label={label}
            checked={intake.injuryStatus === value}
            onSelect={() => {
              actions?.setIntake("injuryStatus", value);
            }}
          />
        ))}
      </fieldset>
      {needsClearance ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>
            Has a clinician cleared your current return to training?
          </legend>
          {([true, false] as const).map((value) => (
            <Radio
              key={String(value)}
              name="clinician-cleared"
              label={value ? "Yes" : "No"}
              checked={intake.clinicianCleared === value}
              onSelect={() => {
                actions?.setIntake("clinicianCleared", value);
              }}
            />
          ))}
        </fieldset>
      ) : null}
    </>
  );
}
