import type { ReactElement } from "react";
import { isSlashCommandText } from "./commands.js";
import styles from "./Message.module.css";

export function AthleteMessage(props: { readonly text: string }): ReactElement {
  const className = isSlashCommandText(props.text)
    ? `${styles.text} ${styles.command} chat-message__text`
    : `${styles.text} chat-message__text`;
  return <div className={className}>{props.text}</div>;
}
