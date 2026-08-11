import type { ReactElement, ReactNode } from "react";

export const SETUP_CARD_CLASS =
  "rounded-xl border border-line bg-surface shadow-[var(--edge),var(--elev-1)] [&>*+*]:border-t [&>*+*]:border-line [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl";

export {
  BUTTON_DANGER_LINK_SM,
  BUTTON_DANGER_SM,
  BUTTON_OUTLINE_SM,
  BUTTON_PRIMARY,
  BUTTON_QUIET_SM,
  BUTTON_SOLID_SM,
} from "../shared/buttons.js";

export const SETUP_LINK_BUTTON =
  "mt-2 block bg-transparent p-0 text-left text-xs font-medium text-ink-2 underline underline-offset-[3px] transition-colors hover:text-ink disabled:opacity-50 motion-reduce:transition-none";

export const SETUP_HINT_CLASS = "mt-[7px] block text-[11.5px] leading-normal text-ink-2";

export const SETUP_FIELD_CLASS =
  "h-[30px] w-full max-w-[236px] rounded-ctl border border-ink-2 bg-surface px-[11px] text-sm text-ink shadow-[var(--edge),var(--elev-1)] disabled:opacity-64";

export const SETUP_LABEL_CLASS = "mb-[5px] block text-xs font-medium text-ink-2";

export function SetupCard(props: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={SETUP_CARD_CLASS} data-setup-card="">
      {props.children}
    </div>
  );
}
