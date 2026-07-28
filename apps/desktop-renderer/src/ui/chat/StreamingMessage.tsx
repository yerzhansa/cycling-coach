import { useLayoutEffect, useRef, type ReactElement } from "react";
import { chatStreamBuffer } from "../../state/chat-stream.js";
import styles from "./Message.module.css";

export function StreamingMessage(props: { readonly messageId: string }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const messageId = props.messageId;

  useLayoutEffect(() => {
    chatStreamBuffer.attach(messageId, host.current);
    return () => {
      chatStreamBuffer.attach(messageId, null);
    };
  }, [messageId]);

  return <div className={`${styles.text} chat-message__text`} ref={host} />;
}
