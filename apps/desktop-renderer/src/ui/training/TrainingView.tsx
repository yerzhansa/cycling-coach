import type { ReactElement } from "react";
import { Page } from "../shared/Page.js";
import styles from "./TrainingView.module.css";

export function TrainingView(): ReactElement {
  return (
    <Page title="Training">
      <p className={styles.note}>
        Your wellness, zones, plan and sync still live in the training data drawer on the chat
        page; they move onto this page later in the renderer rebuild.
      </p>
    </Page>
  );
}
