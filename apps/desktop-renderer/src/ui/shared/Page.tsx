import type {
  KeyboardEventHandler,
  ReactElement,
  ReactNode,
  Ref,
} from "react";
import styles from "./Page.module.css";

export function Page(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly busy?: boolean;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
  readonly ref?: Ref<HTMLElement>;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      ref={props.ref}
      className={
        props.className === undefined ? styles.page : `${styles.page} ${props.className}`
      }
      aria-label={props.title}
      aria-busy={props.busy === true ? "true" : undefined}
      onKeyDown={props.onKeyDown}
    >
      <div className={styles.bar}>
        <h1 className={styles.title}>{props.title}</h1>
        {props.subtitle === undefined ? null : (
          <span className={styles.subtitle}>{props.subtitle}</span>
        )}
        {props.action === undefined ? null : <div className={styles.action}>{props.action}</div>}
      </div>
      <div className={styles.scroll}>
        <div className={styles.column}>{props.children}</div>
      </div>
    </section>
  );
}
