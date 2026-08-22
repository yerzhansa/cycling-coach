import { useLayoutEffect, useRef, type ReactElement } from "react";
import { renderCoachMarkdown } from "../../chat/markdown.js";
import { MESSAGE_TEXT_CLASS } from "./Message.js";

export function CoachMessage(props: { readonly text: string }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const text = props.text;

  useLayoutEffect(() => {
    const node = host.current;
    if (node === null) return;
    renderCoachMarkdown(node, text);
  }, [text]);

  return <div className={MESSAGE_TEXT_CLASS} ref={host} />;
}
