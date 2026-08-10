import type { ReactElement, ReactNode } from "react";

export const SETUP_CARD_CLASS =
  "rounded-xl border border-line bg-surface shadow-[var(--edge),var(--elev-1)] [&>*+*]:border-t [&>*+*]:border-line [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl";

const BUTTON_BASE =
  "inline-flex flex-none items-center justify-center gap-1.5 rounded-ctl border whitespace-nowrap font-medium transition-colors disabled:opacity-50 motion-reduce:transition-none";

const BUTTON_SM = `${BUTTON_BASE} h-ctl-sm px-[9px] text-[13px]`;

export const BUTTON_SOLID_SM = `${BUTTON_SM} border-ink bg-ink text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--ink)_90%,var(--bg))]`;

export const BUTTON_OUTLINE_SM = `${BUTTON_SM} border-ink-2 bg-surface text-ink shadow-[var(--edge),var(--elev-1)] hover:bg-surface-2`;

export const BUTTON_QUIET_SM = `${BUTTON_SM} border-transparent bg-transparent text-ink-2 hover:bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] hover:text-ink`;

export const BUTTON_DANGER_SM = `${BUTTON_SM} border-[color-mix(in_srgb,var(--danger)_34%,transparent)] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] text-danger shadow-none hover:bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]`;

export const BUTTON_PRIMARY = `${BUTTON_BASE} h-ctl-lg gap-2 px-[14px] text-sm border-ink bg-ink text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--ink)_90%,var(--bg))]`;

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
