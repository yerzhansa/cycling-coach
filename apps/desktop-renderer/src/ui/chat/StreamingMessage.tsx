import { useLayoutEffect, useRef, type ReactElement } from "react";
import { chatStreamBuffer } from "../../state/chat-stream";
import { COACH_MESSAGE_TEXT_CLASS } from "./Message";

export function StreamingMessage(props: { readonly messageId: string }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const messageId = props.messageId;

  useLayoutEffect(() => {
    chatStreamBuffer.attach(messageId, host.current);
    return () => {
      chatStreamBuffer.attach(messageId, null);
    };
  }, [messageId]);

  return <div className={COACH_MESSAGE_TEXT_CLASS} ref={host} />;
}
