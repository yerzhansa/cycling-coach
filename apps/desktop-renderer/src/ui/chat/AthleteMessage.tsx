import type { ReactElement } from "react";
import { isSlashCommandText } from "../../chat/commands.js";
import { cn } from "../../lib/utils.js";
import { MESSAGE_COMMAND_CLASS, MESSAGE_TEXT_CLASS } from "./Message.js";

export function AthleteMessage(props: { readonly text: string }): ReactElement {
  const className = cn(MESSAGE_TEXT_CLASS, isSlashCommandText(props.text) && MESSAGE_COMMAND_CLASS);
  return <div className={className}>{props.text}</div>;
}
