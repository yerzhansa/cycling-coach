import { useEffect, useRef, type ReactElement } from "react";
import { rideImportStatusCopy } from "../../ride-import.js";
import { useEnduragentStore } from "../../state/store.js";
import { Page } from "../shared/Page.js";
import { AiRow } from "./AiRow.js";
import {
  ERROR_COPY,
  FOOTER_NOTE,
  CHATGPT_PHASE_COPY,
  OUTSTANDING_NOTE,
  PRIMARY_LABEL,
  SETUP_HEADING,
} from "./copy.js";
import { IntakeRows } from "./IntakeRows.js";
import { BUTTON_PRIMARY, BUTTON_QUIET_SM, SetupCard } from "./SetupCard.js";
import { SetupError } from "./SetupRow.js";
import { TrainingRow } from "./TrainingRow.js";

export function OnboardingWizard(): ReactElement | null {
  const surface = useEnduragentStore((state) => state.onboarding);
  const actions = useEnduragentStore((state) => state.onboardingActions);
  const page = useRef<HTMLElement>(null);
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
    page.current?.querySelector<HTMLElement>("#onboarding-title")?.focus();
  }, [open, focusSeq]);

  useEffect(
    () => () => {
      const current = useEnduragentStore.getState();
      if (current.onboarding.open) current.onboardingActions?.dismiss();
    },
    [],
  );

  if (!open) return null;

  const wizard = surface.wizard;
  const readiness = surface.readiness;
  const importCopy = rideImportStatusCopy(surface.rideImport);
  const actionStatus = surface.actionStatus ?? (wizard.busy ? "working" : null);
  const actionStatusCopy =
    actionStatus === null
      ? ""
      : actionStatus === "working"
        ? "Working…"
        : CHATGPT_PHASE_COPY[actionStatus];
  const blocked =
    wizard.busy ||
    surface.rideImport.status === "running" ||
    !readiness.provider ||
    !readiness.trainingData ||
    !readiness.intake;
  const outstanding = !readiness.provider
    ? "coach"
    : !readiness.trainingData
      ? "training"
      : !readiness.intake
        ? wizard.intake.injuryStatus === null
          ? "intake"
          : "clearance"
        : null;

  return (
    <Page
      ref={page}
      title="Setup"
      className="onboarding"
      action={
        <button
          type="button"
          className={`${BUTTON_QUIET_SM} onboarding-dismiss`}
          onClick={() => {
            actions?.dismiss();
          }}
        >
          Dismiss
        </button>
      }
    >
      <h2
        id="onboarding-title"
        tabIndex={-1}
        className="mb-4 text-[21px] font-medium tracking-tight focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
      >
        {SETUP_HEADING}
      </h2>
      <SetupCard>
        <AiRow surface={surface} actions={actions} />
        <TrainingRow surface={surface} actions={actions} />
        <IntakeRows surface={surface} actions={actions} />
      </SetupCard>
      <p
        className="import-status mt-2 min-h-[18px] text-xs text-ink-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        hidden={importCopy.length === 0}
        data-state={surface.rideImport.status}
      >
        {importCopy}
      </p>
      <footer className="mt-3.5 flex items-center justify-between gap-3 border-t border-line pt-3.5">
        <span className="text-xs text-ink-2">{FOOTER_NOTE}</span>
        <SetupError surface={surface} section="footer" />
        {outstanding === null ? null : (
          <span data-setup-outstanding={outstanding} className="text-xs text-ink-2">
            {OUTSTANDING_NOTE[outstanding]}
          </span>
        )}
        <button
          type="button"
          className={BUTTON_PRIMARY}
          disabled={blocked}
          onClick={() => {
            actions?.finish();
          }}
        >
          {PRIMARY_LABEL}
        </button>
      </footer>
      <p
        className="onboarding-action-status mt-1.5 text-xs text-ink-2"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        hidden={actionStatus === null}
        data-state={actionStatus ?? "idle"}
      >
        {actionStatusCopy}
      </p>
      <p className="onboarding-error-announcer sr-only" role="status" aria-live="polite">
        {wizard.fixedError === null ? "" : ERROR_COPY[wizard.fixedError]}
      </p>
    </Page>
  );
}
