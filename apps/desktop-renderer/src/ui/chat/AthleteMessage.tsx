import type { ReactElement } from "react";
import styles from "./AthleteMessage.module.css";
import { isSlashCommandText } from "./commands.js";

export function AthleteMessage(props: { readonly text: string }): ReactElement {
  const className = isSlashCommandText(props.text)
    ? `chat-message__text ${styles.command}`
    : "chat-message__text";
  return <div className={className}>{props.text}</div>;
}
