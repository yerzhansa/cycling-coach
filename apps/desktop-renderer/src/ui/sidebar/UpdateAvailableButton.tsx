import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Sidebar.module.css";

interface UpdateAvailableButtonProps {
  readonly locked: boolean;
}

export function UpdateAvailableButton({ locked }: UpdateAvailableButtonProps): ReactElement {
  const update = useEnduragentStore((state) => state.settings.update);
  const updatePort = useEnduragentStore((state) => state.settingsPorts?.update ?? null);
  const visible = update.state.status === "downloaded" || update.state.status === "installing";
  const restarting = update.actionDisabled || update.state.status === "installing";
  const version = visible ? update.state.version : null;
  const announcement =
    version === null
      ? ""
      : restarting
        ? `Restarting to install update version ${version}`
        : `Update version ${version} is available`;

  return (
    <>
      {visible ? (
        <button
          type="button"
          className={styles.updateButton}
          aria-label={
            restarting
              ? `Restarting to install update version ${version}`
              : `Install update version ${version}`
          }
          aria-busy={restarting ? "true" : undefined}
          disabled={locked || restarting || updatePort === null}
          onClick={() => {
            updatePort?.activate();
          }}
        >
          {restarting ? "Restarting…" : "Update available"}
        </button>
      ) : null}
      <span
        className={`${styles.srOnly} update-announcement`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
    </>
  );
}
