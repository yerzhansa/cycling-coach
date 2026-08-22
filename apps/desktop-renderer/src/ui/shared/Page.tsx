import type { KeyboardEventHandler, ReactElement, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils.js";

export function Page(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly busy?: boolean;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
  readonly ref?: Ref<HTMLElement>;
  readonly titleRef?: Ref<HTMLHeadingElement>;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section
      ref={props.ref}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", props.className)}
      aria-label={props.title}
      aria-busy={props.busy === true ? "true" : undefined}
      onKeyDown={props.onKeyDown}
    >
      <div className="flex h-[52px] flex-none items-center gap-row border-b border-line px-5">
        <h1
          ref={props.titleRef}
          className="m-0 text-sm font-semibold tracking-normal"
          tabIndex={props.titleRef === undefined ? undefined : -1}
        >
          {props.title}
        </h1>
        {props.subtitle === undefined ? null : (
          <span className="text-xs text-ink-3">{props.subtitle}</span>
        )}
        {props.action === undefined ? null : (
          <div className="ml-auto flex items-center gap-inset">{props.action}</div>
        )}
      </div>
      <div className="flex-1 overflow-auto pt-7 pb-10 overscroll-contain" data-page-scroll>
        <div className="mx-auto w-[min(680px,calc(100%-64px))]">{props.children}</div>
      </div>
    </section>
  );
}
