import { useEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { ONBOARDING_STEP_IDS } from "../../onboarding/constants.js";
import { rideImportStatusCopy } from "../../ride-import.js";
import { useEnduragentStore } from "../../state/store.js";
import { CoachKeysStep } from "./CoachKeysStep.js";
import { ERROR_COPY } from "./copy.js";
import styles from "./OnboardingWizard.module.css";
import { ReadyStep } from "./ReadyStep.js";
import { SafetyIntakeStep } from "./SafetyIntakeStep.js";
import { TrainingDataStep } from "./TrainingDataStep.js";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusableElements(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.hasAttribute("hidden")) return false;
    const closedDetails = element.closest("details:not([open])");
    return closedDetails === null || element.tagName === "SUMMARY";
  });
}

export function OnboardingWizard(): ReactElement | null {
  const surface = useEnduragentStore((state) => state.onboarding);
  const actions = useEnduragentStore((state) => state.onboardingActions);
  const dialog = useRef<HTMLElement>(null);
  const focused = useRef(-1);

  const open = surface.open;
  const focusSeq = surface.focusSeq;

  useEffect(() => {
    if (!open) {
      focused.current = -1;
      return;
    }
    if (focused.current === focusSeq) return;
    focused.current = focusSeq;
    dialog.current?.querySelector<HTMLElement>("#onboarding-title")?.focus();
  }, [open, focusSeq]);

  if (!open) return null;

  const wizard = surface.wizard;
  const activeIndex = ONBOARDING_STEP_IDS.indexOf(wizard.step);
  const importBusy = wizard.step === "training-data" && surface.rideImport.status === "running";
  const disabled = wizard.busy || importBusy;
  const importCopy = rideImportStatusCopy(surface.rideImport);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const targetTagName = (event.target as HTMLElement | null)?.tagName;
    if (event.key === "Escape") {
      event.preventDefault();
      actions?.dismiss();
      return;
    }
    if (
      event.key === "Enter" &&
      targetTagName !== "BUTTON" &&
      targetTagName !== "SUMMARY" &&
      targetTagName !== "SELECT"
    ) {
      event.preventDefault();
      actions?.submit();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialog.current;
    if (root === null) return;
    const focusable = focusableElements(root);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`${styles.scrim} onboarding-scrim`}>
      <section
        ref={dialog}
        className={`${styles.dialog} onboarding`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <div
            className={`${styles.progress} onboarding-progress`}
            aria-label={`Step ${activeIndex + 1} of ${ONBOARDING_STEP_IDS.length}`}
          >
            {ONBOARDING_STEP_IDS.map((step, index) => (
              <span
                key={step}
                className={index <= activeIndex ? styles.progressOn : undefined}
                aria-current={step === wizard.step ? "step" : undefined}
              />
            ))}
          </div>
          <button
            type="button"
            className={`${styles.dismiss} onboarding-dismiss`}
            onClick={() => {
              actions?.dismiss();
            }}
          >
            Dismiss
          </button>
        </header>
        <div className={styles.body}>
          {wizard.step === "coach-keys" ? (
            <CoachKeysStep surface={surface} actions={actions} disabled={disabled} />
          ) : null}
          {wizard.step === "training-data" ? (
            <TrainingDataStep surface={surface} actions={actions} disabled={disabled} />
          ) : null}
          {wizard.step === "safety-intake" ? (
            <SafetyIntakeStep surface={surface} actions={actions} />
          ) : null}
          {wizard.step === "ready" ? <ReadyStep surface={surface} /> : null}
          <p
            className={`${styles.importStatus} import-status`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            hidden={importCopy.length === 0}
            data-state={surface.rideImport.status}
          >
            {importCopy}
          </p>
          <p id="onboarding-error" className={styles.error} aria-live="polite">
            {wizard.fixedError === null ? "" : ERROR_COPY[wizard.fixedError]}
          </p>
          <p
            className={`${styles.actionStatus} onboarding-action-status`}
            role="status"
            aria-live="polite"
            hidden={!wizard.busy}
          >
            {wizard.busy ? "Working…" : ""}
          </p>
        </div>
        <footer className={styles.footer}>
          {activeIndex > 0 ? (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={disabled}
              onClick={() => {
                actions?.back();
              }}
            >
              Back
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={disabled}
            onClick={() => {
              actions?.submit();
            }}
          >
            {wizard.step === "ready" ? "Finish setup" : "Continue"}
          </button>
        </footer>
      </section>
    </div>
  );
}
