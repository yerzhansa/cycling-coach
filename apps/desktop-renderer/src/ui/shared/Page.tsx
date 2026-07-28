import type { ReactElement, ReactNode } from "react";
import styles from "./Page.module.css";

export function Page(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly busy?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      className={styles.page}
      aria-label={props.title}
      aria-busy={props.busy === true ? "true" : undefined}
    >
      <div className={styles.bar}>
        <h1 className={styles.title}>{props.title}</h1>
        {props.subtitle === undefined ? null : (
          <span className={styles.subtitle}>{props.subtitle}</span>
        )}
      </div>
      <div className={styles.scroll}>
        <div className={styles.column}>{props.children}</div>
      </div>
    </section>
  );
}
