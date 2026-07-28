import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import { PALETTES } from "../../theme/palettes.js";
import styles from "./PalettePicker.module.css";

export function PalettePicker(): ReactElement {
  const paletteId = useEnduragentStore((state) => state.paletteId);
  const setPaletteId = useEnduragentStore((state) => state.setPaletteId);

  return (
    <div className={styles.grid} role="group" aria-label="App palette">
      {PALETTES.map((palette) => (
        <button
          key={palette.id}
          type="button"
          className={
            palette.id === paletteId ? `${styles.palette} ${styles.on}` : styles.palette
          }
          aria-pressed={palette.id === paletteId}
          aria-label={`Use the ${palette.name} palette`}
          onClick={() => {
            setPaletteId(palette.id);
          }}
        >
          <span className={styles.swatch} aria-hidden="true">
            <span className={styles.half} style={{ background: palette.l.bg }}>
              <span className={styles.mark} style={{ background: palette.l.br }} />
            </span>
            <span className={styles.half} style={{ background: palette.d.bg }}>
              <span className={styles.mark} style={{ background: palette.d.br }} />
            </span>
          </span>
          <span className={styles.name}>{palette.name}</span>
        </button>
      ))}
    </div>
  );
}
