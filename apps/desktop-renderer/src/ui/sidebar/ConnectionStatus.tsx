import type { ReactElement } from "react";
import { connectionCopy, connectionTone } from "../../state/connection-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import styles from "./Sidebar.module.css";

export function ConnectionStatus(): ReactElement {
  const connection = useEnduragentStore((store) => store.connection);
  const tone = connectionTone(connection);

  return (
    <p className={`${styles.connection} connection-status`} data-tone={tone} role="status">
      <span className={styles.dot} data-tone={tone} aria-hidden="true" />
      {connectionCopy(connection)}
    </p>
  );
}
