import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import AppearanceStyles from "./AppearanceControl.module.css";
import {
  MANAGED_BY_ENVIRONMENT_COPY,
  TIMEZONE_MODE_COPY,
  timezoneModeDetailCopy,
} from "./copy.js";
import styles from "./SettingsView.module.css";

const OPTIONS: readonly { readonly value: DesktopSessionTimezoneMode; readonly label: string }[] =
  Object.freeze([
    { value: "follow", label: TIMEZONE_MODE_COPY.followLabel },
    { value: "fixed", label: TIMEZONE_MODE_COPY.fixedLabel },
  ]);

export function TimezoneModeControl(): ReactElement {
  const state = useEnduragentStore((store) => store.sessionTimezoneMode);
  const actions = useEnduragentStore((store) => store.sessionTimezoneModeActions);

  return (
    <div className={styles.row} data-timezone-mode={state.status}>
      <div className={styles.label}>
        <div className={styles.rowTitle}>{TIMEZONE_MODE_COPY.title}</div>
        <div className={styles.rowDetail}>{timezoneModeDetailCopy(state)}</div>
        {state.status === "failed" ? (
          <div className={styles.error} role="status" aria-live="polite">
            {TIMEZONE_MODE_COPY.failed}
          </div>
        ) : null}
      </div>
      {state.status === "environment-managed" ? (
        <div className={styles.rowDetail} data-timezone-mode-managed="true">
          {MANAGED_BY_ENVIRONMENT_COPY}
        </div>
      ) : (
        <div
          className={AppearanceStyles.seg}
          role="group"
          aria-label={TIMEZONE_MODE_COPY.groupLabel}
        >
          {OPTIONS.map((option) => {
            const active =
              (state.status === "ready" || state.status === "saving" || state.status === "failed") &&
              state.mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={
                  active
                    ? `${AppearanceStyles.option} ${AppearanceStyles.on}`
                    : AppearanceStyles.option
                }
                aria-pressed={active}
                disabled={
                  actions === null ||
                  state.status === "loading" ||
                  state.status === "unavailable" ||
                  state.status === "saving"
                }
                onClick={() => {
                  actions?.choose(option.value);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
