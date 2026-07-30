import type { ReactElement } from "react";
import type { SlashCommand } from "../../chat/commands.js";
import styles from "./SlashPopup.module.css";

export function SlashPopup(props: {
  readonly open: boolean;
  readonly matches: readonly SlashCommand[];
  readonly selected: number;
  readonly onHighlight: (index: number) => void;
  readonly onAccept: (index: number) => void;
}): ReactElement | null {
  if (!props.open) return null;

  return (
    <div className={styles.popup} role="listbox" aria-label="Commands">
      <div className={styles.caption}>Commands</div>
      <ul className={styles.list}>
        {props.matches.map((match, index) => (
          <li
            key={match.command}
            role="option"
            aria-selected={index === props.selected}
            className={index === props.selected ? `${styles.item} ${styles.chosen}` : styles.item}
            onMouseEnter={() => {
              props.onHighlight(index);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              props.onAccept(index);
            }}
          >
            <span className={styles.command}>{match.command}</span>
            <span className={styles.description}>{match.description}</span>
          </li>
        ))}
      </ul>
      <div className={styles.foot}>
        <span>
          <span className={styles.key}>↑↓</span> choose
        </span>
        <span>
          <span className={styles.key}>↩</span> insert
        </span>
        <span>
          <span className={styles.key}>esc</span> close
        </span>
      </div>
    </div>
  );
}
