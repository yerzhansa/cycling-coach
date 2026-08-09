import type { ReactElement } from "react";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller.js";
import { errorSection } from "../../onboarding/lanes.js";
import { SETUP_FIELD_CLASS } from "./SetupCard.js";
import { SetupError, SetupRow, SetupSubPanel } from "./SetupRow.js";

const UNSET = "";

const INJURY_OPTIONS = [
  [UNSET, "Select…"],
  ["none", "No current injury"],
  ["managing", "Managing an injury"],
  ["returning", "Returning after an injury"],
] as const;

const YES_NO_OPTIONS = [
  [UNSET, "Select…"],
  ["no", "No"],
  ["yes", "Yes"],
] as const;

function boolValue(value: boolean | null): string {
  return value === null ? UNSET : value ? "yes" : "no";
}

function parseBool(value: string): boolean | null {
  return value === "yes" ? true : value === "no" ? false : null;
}

function IntakeSelect(props: {
  readonly id: string;
  readonly value: string;
  readonly options: ReadonlyArray<readonly [string, string]>;
  readonly disabled: boolean;
  readonly describedBy?: string;
  readonly onSelect: (value: string) => void;
}): ReactElement {
  return (
    <select
      id={props.id}
      className={`${SETUP_FIELD_CLASS} w-[180px]`}
      disabled={props.disabled}
      value={props.value}
      aria-describedby={props.describedBy}
      onChange={(event) => {
        props.onSelect(event.target.value);
      }}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function IntakeRows(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
}): ReactElement {
  const { surface, actions } = props;
  const wizard = surface.wizard;
  const intake = wizard.intake;
  const controlsDisabled = wizard.busy || surface.loading || surface.loadUnavailable;
  const needsClearance = intake.injuryStatus !== null && intake.injuryStatus !== "none";
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "intake";
  const describedBy = ownsError ? { describedBy: "onboarding-error" } : {};

  return (
    <>
      <SetupRow
        id="injury-status"
        status="none"
        title="Injury status right now"
        subtitle="Records your current injury or return context."
        titleFor="onboarding-injury-status"
        trailing={
          <IntakeSelect
            id="onboarding-injury-status"
            value={intake.injuryStatus ?? UNSET}
            options={INJURY_OPTIONS}
            disabled={controlsDisabled}
            {...describedBy}
            onSelect={(value) => {
              actions?.setIntake(
                "injuryStatus",
                value === UNSET ? null : (value as "none" | "managing" | "returning"),
              );
            }}
          />
        }
      />
      {needsClearance ? (
        <SetupRow
          id="clinician-cleared"
          status="none"
          title="Cleared by a clinician"
          subtitle="An answer is required before continuing."
          titleFor="onboarding-clinician-cleared"
          trailing={
            <IntakeSelect
              id="onboarding-clinician-cleared"
              value={boolValue(intake.clinicianCleared)}
              options={YES_NO_OPTIONS}
              disabled={controlsDisabled}
              {...describedBy}
              onSelect={(value) => {
                actions?.setIntake("clinicianCleared", parseBool(value));
              }}
            />
          }
        />
      ) : null}
      {ownsError ? (
        <SetupSubPanel name="intake-error">
          <SetupError surface={surface} section="intake" />
        </SetupSubPanel>
      ) : null}
    </>
  );
}
