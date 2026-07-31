import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import type { Appearance } from "../../theme/applyPalette.js";
import styles from "./AppearanceControl.module.css";

const OPTIONS: readonly { readonly value: Appearance; readonly label: string }[] = Object.freeze([
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]);

export function AppearanceControl(): ReactElement {
  const appearance = useEnduragentStore((state) => state.appearance);
  const setAppearance = useEnduragentStore((state) => state.setAppearance);

  return (
    <div className={styles.seg} role="group" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === appearance ? `${styles.option} ${styles.on}` : styles.option}
          aria-pressed={option.value === appearance}
          onClick={() => {
            setAppearance(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
