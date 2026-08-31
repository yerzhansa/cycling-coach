import type { ReactElement } from "react";
import { isSlashCommandText } from "../../chat/commands";
import { cn } from "../../lib/utils";
import { MESSAGE_COMMAND_CLASS, MESSAGE_TEXT_CLASS } from "./Message";

export function AthleteMessage(props: { readonly text: string }): ReactElement {
  const className = cn(MESSAGE_TEXT_CLASS, isSlashCommandText(props.text) && MESSAGE_COMMAND_CLASS);
  return <div className={className}>{props.text}</div>;
}
