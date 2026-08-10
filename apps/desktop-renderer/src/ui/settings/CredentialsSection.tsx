import { Fragment, useEffect, useRef, type ReactElement } from "react";
import type { DesktopCredentialId } from "../../onboarding/bridge.js";
import { DESKTOP_CREDENTIAL_SLOTS } from "../../onboarding/constants.js";
import { onboardingCredentialMutationActive } from "../../onboarding/controller.js";
import { claudeCliPresentation } from "../../onboarding/credential-presentation.js";
import type {
  CredentialSettingsEntry,
  CredentialSettingsState,
} from "../../settings/credential-controller.js";
import {
  credentialChangesBlocked,
  repairRequiredCredential,
} from "../../settings/credential-controller.js";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { SetupRow, SetupSubPanel } from "../onboarding/SetupRow.js";
import { BUTTON_QUIET_SM } from "../onboarding/SetupCard.js";
import { credentialRuntimeLabel } from "./copy.js";
import styles from "./SettingsView.module.css";

export const SETUP_CREDENTIAL_EDIT_EVENT = "enduragent:edit-credential";

export interface SetupCredentialEditDetail {
  readonly credential: DesktopCredentialId;
}

function content(state: CredentialSettingsState) {
  if (
    state.status === "ready" ||
    state.status === "confirming" ||
    state.status === "deleting" ||
    state.status === "deleted" ||
    (state.status === "error" && state.kind === "delete")
  ) {
    return state;
  }
  return null;
}

export function desktopCredentialId(
  provider: string | null | undefined,
): DesktopCredentialId | null {
  if (provider === "openai-codex") return provider;
  return DESKTOP_CREDENTIAL_SLOTS.find((credential) => credential === provider) ?? null;
}

function entryFor(
  state: CredentialSettingsState,
  credential: DesktopCredentialId,
): CredentialSettingsEntry | null {
  return content(state)?.entries.find((entry) => entry.credential === credential) ?? null;
}

function openCredentialEditor(credential: DesktopCredentialId): void {
  const selector =
    credential === "intervals-icu"
      ? '[data-setup-trigger="training"]'
      : '[data-setup-trigger="ai"]';
  const trigger = document.querySelector<HTMLButtonElement>(selector);
  trigger?.focus();
  if (credential === "intervals-icu") {
    trigger?.click();
    return;
  }
  trigger?.dispatchEvent(
    new CustomEvent<SetupCredentialEditDetail>(SETUP_CREDENTIAL_EDIT_EVENT, {
      bubbles: true,
      detail: { credential },
    }),
  );
}

export function CredentialDeleteButton(props: {
  readonly credential: DesktopCredentialId;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const setupLoading = useEnduragentStore((store) => store.onboarding.loading);
  const onboardingMutating = useEnduragentStore((store) =>
    onboardingCredentialMutationActive(store.onboarding),
  );
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const button = useRef<HTMLButtonElement>(null);
  const entry = entryFor(state, props.credential);
  const target = "focus" in state ? state.focus : null;
  const confirmation = content(state)?.confirmation ?? null;
  const repairRequired = repairRequiredCredential(state) !== null;

  useEffect(() => {
    if (target?.target === "delete" && target.credential === props.credential) {
      button.current?.focus();
    }
  }, [props.credential, target]);

  if (entry === null) return null;
  return (
    <button
      type="button"
      ref={button}
      data-setup-delete={entry.credential}
      className={styles.danger}
      disabled={
        mutating || setupLoading || onboardingMutating || confirmation !== null || repairRequired
      }
      aria-label={`Delete the ${entry.provider} credential`}
      onClick={() => port?.requestDelete(entry.credential)}
    >
      Delete
    </button>
  );
}

export function CredentialDeleteConfirmation(props: {
  readonly credential: DesktopCredentialId;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const onboardingMutating = useEnduragentStore((store) =>
    onboardingCredentialMutationActive(store.onboarding),
  );
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const entry = entryFor(state, props.credential);
  const target = "focus" in state ? state.focus : null;
  const confirmation = content(state)?.confirmation ?? null;
  const deleting = state.status === "deleting";

  useEffect(() => {
    if (confirmation !== props.credential) return;
    if (target?.target === "confirmation-cancel") cancel.current?.focus();
    else if (target?.target === "confirmation-delete") confirm.current?.focus();
  }, [confirmation, props.credential, target]);

  if (entry === null || confirmation !== props.credential) return null;
  return (
    <SetupSubPanel name={`delete-${entry.credential}`}>
      <div
        className={styles.confirmation}
        role="group"
        aria-labelledby={`credential-confirm-${entry.credential}`}
      >
        <p className={styles.confirmationTitle} id={`credential-confirm-${entry.credential}`}>
          Delete the {entry.provider} credential?
        </p>
        <p className={styles.confirmationCopy}>
          This removes it from this Mac only. Enduragent will stop using it if it is active. Your
          provider account is unchanged.
        </p>
        <div className={styles.confirmationActions}>
          <button
            type="button"
            ref={cancel}
            className={styles.button}
            disabled={mutating}
            onClick={() => port?.cancelDelete()}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={confirm}
            className={styles.danger}
            disabled={deleting ? false : mutating || onboardingMutating}
            aria-disabled={deleting ? "true" : undefined}
            aria-label={`Confirm deletion of the ${entry.provider} credential`}
            onClick={() => {
              if (!deleting) port?.confirmDelete();
            }}
          >
            Delete credential
          </button>
        </div>
      </div>
    </SetupSubPanel>
  );
}

export function AdditionalCredentialRows(props: {
  readonly primaryAiCredential: DesktopCredentialId | null;
  readonly primaryAiProvider: string | null;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const setupLoading = useEnduragentStore((store) => store.onboarding.loading);
  const onboardingMutating = useEnduragentStore((store) =>
    onboardingCredentialMutationActive(store.onboarding),
  );
  const entries = (content(state)?.entries ?? []).filter(
    (entry) =>
      entry.credential !== "intervals-icu" && entry.credential !== props.primaryAiCredential,
  );
  const changesBlocked = credentialChangesBlocked(state, mutating);
  const providerStatuses = (content(state)?.providerStatuses ?? []).filter(
    (entry) => entry.provider !== props.primaryAiProvider,
  );

  if (entries.length === 0 && providerStatuses.length === 0) return null;
  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.credential}>
          <SetupRow
            id={`saved-${entry.credential}`}
            status="none"
            title={entry.provider}
            subtitle={`${entry.kind} · ${credentialRuntimeLabel(entry.runtimeState)}`}
            trailing={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className={BUTTON_QUIET_SM}
                  disabled={setupLoading || onboardingMutating || changesBlocked}
                  aria-label={`Change the ${entry.provider} credential`}
                  onClick={() => openCredentialEditor(entry.credential)}
                >
                  Change
                </button>
                <CredentialDeleteButton credential={entry.credential} />
              </div>
            }
          />
          <CredentialDeleteConfirmation credential={entry.credential} />
        </Fragment>
      ))}
      {providerStatuses.map((entry) => {
        const presentation = claudeCliPresentation(entry.state);
        return (
          <SetupRow
            key={entry.provider}
            id={`provider-${entry.provider}`}
            dataProvider={entry.provider}
            status="none"
            title={entry.label}
            subtitle={
              <>
                {entry.kind} · {presentation.badge}
                {entry.identity === null ? null : (
                  <>
                    {" "}
                    · <span data-provider-identity="">{entry.identity}</span>
                  </>
                )}
              </>
            }
          />
        );
      })}
    </>
  );
}

export function CredentialSettingsFeedback(): ReactElement | null {
  const state = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.credentials ?? null);
  const feedback = useRef<HTMLDivElement>(null);
  const target = "focus" in state ? state.focus : null;
  const loading = state.status === "closed" || state.status === "loading";
  const loadError = state.status === "error" && state.kind === "load";
  const repairRequired = repairRequiredCredential(state);
  const announcement =
    "announcement" in state && state.announcement.length > 0
      ? state.announcement
      : loading
        ? "Loading saved credentials…"
        : "";

  useEffect(() => {
    if (target?.target === "feedback") {
      feedback.current?.focus();
      return;
    }
    if (target?.target !== "setup") return;
    const selector =
      target.credential === "intervals-icu"
        ? '[data-setup-trigger="training"]'
        : '[data-setup-trigger="ai"]';
    const action = document.querySelector<HTMLButtonElement>(selector);
    if (action !== null && !action.disabled) action.focus();
    else document.querySelector<HTMLElement>("#setup-panel-title")?.focus();
  }, [target]);

  if (announcement.length === 0 && !loadError && repairRequired === null) return null;
  return (
    <div
      ref={feedback}
      tabIndex={-1}
      className="w-full bg-sunk px-[15px] py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink"
      data-credential-feedback=""
    >
      {announcement.length === 0 ? null : (
        <p className="m-0 text-xs text-ink-2" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      )}
      {loadError || repairRequired !== null ? (
        <button
          type="button"
          className={`${styles.button} mt-2`}
          disabled={mutating || loading}
          onClick={() => port?.retry()}
        >
          {repairRequired === null ? "Reconnect & reload" : "Reload credential status"}
        </button>
      ) : null}
    </div>
  );
}
