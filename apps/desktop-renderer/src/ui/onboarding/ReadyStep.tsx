import type { ReactElement } from "react";
import type { OnboardingSurfaceState } from "../../onboarding/controller.js";
import styles from "./OnboardingWizard.module.css";

export function ReadyStep(props: { readonly surface: OnboardingSurfaceState }): ReactElement {
  const connected = props.surface.wizard.credentialStatus["intervals-icu"] === "configured";

  return (
    <>
      <p className={styles.kicker}>Ready</p>
      <h2 id="onboarding-title" className={styles.title} tabIndex={-1}>
        Your coach is ready
      </h2>
      <p className={`${styles.copy} onboarding-copy`}>
        Start with what you are training for, how the last week felt, or what you want help
        deciding.
      </p>
      <div className={`${styles.preview} ready-preview`}>
        <span>Keys secured</span>
        <span>
          {connected ? "Training data connected" : "Ride files saved to your local library"}
        </span>
        <span>Safety context saved</span>
      </div>
    </>
  );
}
