import { useEffect, useRef, useState, type ReactElement } from "react";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller.js";
import { credentialPresentation } from "../../onboarding/credential-presentation.js";
import { errorSection } from "../../onboarding/lanes.js";
import {
  IMPORT_FILES_LABEL,
  INTERVALS_PANEL_HINT,
  RETRY_SAVED_KEYS_LABEL,
  TRAINING_CANCEL_LABEL,
  TRAINING_KEY_LABEL,
  TRAINING_ROW_SUBTITLES,
  TRAINING_ROW_TITLE,
  TRAINING_ROW_TOOLTIP,
  TRAINING_SAVE_LABEL,
  TRAINING_TRIGGER_LABELS,
} from "./copy.js";
import { CredentialField } from "./CredentialField.js";
import { InfoTip } from "./InfoTip.js";
import {
  BUTTON_OUTLINE_SM,
  BUTTON_QUIET_SM,
  BUTTON_SOLID_SM,
  SETUP_HINT_CLASS,
  SETUP_LINK_BUTTON,
} from "./SetupCard.js";
import { SetupError, SetupRow, SetupSubPanel } from "./SetupRow.js";

export function TrainingRow(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
}): ReactElement {
  const { surface, actions } = props;
  const wizard = surface.wizard;
  const busy = wizard.busy;
  const importing = surface.rideImport.status === "running";
  const connected = wizard.credentialStatus["intervals-icu"] === "configured";
  const ready = surface.readiness.trainingData;
  const retryable = surface.statuses.some(
    (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
  );
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "training";
  const [open, setOpen] = useState(false);
  const [savePhase, setSavePhase] = useState<"idle" | "requested" | "running">("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = "onboarding-training-panel";

  useEffect(() => {
    if (savePhase === "requested") {
      if (busy && surface.lastCommit === "training") setSavePhase("running");
      else if (!busy) setSavePhase("idle");
      return;
    }
    if (savePhase !== "running" || busy) return;
    if (ready && !retryable && wizard.fixedError === null) {
      setOpen(false);
    }
    setSavePhase("idle");
  }, [busy, ready, retryable, savePhase, surface.lastCommit, wizard.fixedError]);

  const subtitle = connected
    ? TRAINING_ROW_SUBTITLES.connected
    : ready
      ? TRAINING_ROW_SUBTITLES.imported
      : TRAINING_ROW_SUBTITLES.missing;

  const save = (): void => {
    if (actions === null || busy || importing) return;
    setSavePhase("requested");
    actions.saveTrainingKey();
  };

  return (
    <>
      <SetupRow
        id="training"
        status={ready ? "ready" : "pending"}
        title={TRAINING_ROW_TITLE}
        subtitle={subtitle}
        info={
          <InfoTip
            label={TRAINING_ROW_TOOLTIP.label}
            lead={TRAINING_ROW_TOOLTIP.lead}
            body={TRAINING_ROW_TOOLTIP.body}
          />
        }
        trailing={
          <button
            ref={triggerRef}
            type="button"
            data-setup-trigger="training"
            className={connected ? BUTTON_QUIET_SM : BUTTON_OUTLINE_SM}
            disabled={busy}
            aria-expanded={open}
            aria-label={
              connected ? TRAINING_TRIGGER_LABELS.connected : TRAINING_TRIGGER_LABELS.disconnected
            }
            {...(open ? { "aria-controls": panelId } : {})}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            {connected ? "Change" : "Connect"}
          </button>
        }
      />
      {open ? (
        <SetupSubPanel name="training" id={panelId}>
          <CredentialField
            slot="intervals-icu"
            label={TRAINING_KEY_LABEL}
            disabled={busy}
            {...(ownsError ? { describedBy: "onboarding-error" } : {})}
            onEnter={save}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON_SOLID_SM}
              disabled={busy || importing}
              aria-label={TRAINING_SAVE_LABEL}
              onClick={save}
            >
              Save
            </button>
            <button
              type="button"
              className={BUTTON_QUIET_SM}
              disabled={busy}
              aria-label={TRAINING_CANCEL_LABEL}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
          <span className={SETUP_HINT_CLASS}>{INTERVALS_PANEL_HINT}</span>
          {retryable ? (
            <button
              type="button"
              className={SETUP_LINK_BUTTON}
              disabled={busy || importing}
              onClick={() => {
                if (actions === null) return;
                setSavePhase("requested");
                actions.retrySavedKeys();
              }}
            >
              {RETRY_SAVED_KEYS_LABEL}
            </button>
          ) : null}
          <button
            type="button"
            className={SETUP_LINK_BUTTON}
            disabled={busy || importing}
            onClick={() => {
              actions?.chooseImportFiles();
            }}
          >
            {IMPORT_FILES_LABEL}
          </button>
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {!open && ownsError ? (
        <SetupSubPanel name="training-error">
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
    </>
  );
}
