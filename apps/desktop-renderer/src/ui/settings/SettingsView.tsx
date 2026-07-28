import type { ReactElement } from "react";
import { Page } from "../shared/Page.js";
import { AppearanceControl } from "./AppearanceControl.js";
import { PalettePicker } from "./PalettePicker.js";
import styles from "./SettingsView.module.css";

export function SettingsView(): ReactElement {
  return (
    <Page title="Settings">
      <div className={styles.heading}>Preferences</div>
      <div className={styles.group}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Appearance</div>
            <div className={styles.rowDetail}>
              System follows your macOS light and dark setting
            </div>
          </div>
          <AppearanceControl />
        </div>
      </div>
      <div className={styles.heading}>Palette</div>
      <div className={styles.group}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>App palette</div>
            <div className={styles.rowDetail}>
              Changes both themes immediately · Patrol is the default
            </div>
          </div>
        </div>
        <PalettePicker />
      </div>
    </Page>
  );
}
