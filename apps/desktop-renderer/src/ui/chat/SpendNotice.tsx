import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./SpendNotice.module.css";

export function SpendNotice(): ReactElement {
  const warning = useEnduragentStore((store) => store.settings.spend.warning);

  return (
    <p
      id="spend-cap-warning"
      className={styles.notice}
      role="status"
      aria-live="polite"
      hidden={warning === null}
    >
      {warning ?? ""}
    </p>
  );
}
