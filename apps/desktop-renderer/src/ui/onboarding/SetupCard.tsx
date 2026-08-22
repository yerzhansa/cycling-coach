import type { ReactElement, ReactNode } from "react";

export const SETUP_CARD_CLASS =
  "rounded-xl border border-line bg-surface shadow-elev-1 [&>*+*]:border-t [&>*+*]:border-line [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl";

export const SETUP_LINK_BUTTON =
  "mt-2 block cursor-pointer bg-transparent p-0 text-left text-xs font-medium text-ink-2 underline underline-offset-[3px] transition-colors hover:text-ink disabled:cursor-default disabled:opacity-64 motion-reduce:transition-none";

export const SETUP_HINT_CLASS = "mt-[7px] block text-xs leading-normal text-ink-2";

export const SETUP_FIELD_CLASS =
  "h-[30px] w-full max-w-[236px] rounded-ctl border border-ink-2 bg-surface px-[11px] text-sm text-ink shadow-elev-1 disabled:opacity-64";

export const SETUP_SELECT_CLASS = "w-full max-w-[236px]";

export const SETUP_LABEL_CLASS = "mb-[5px] block text-xs font-medium text-ink-2";

export function SetupCard(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={SETUP_CARD_CLASS} data-setup-card="">
      {props.children}
    </div>
  );
}
