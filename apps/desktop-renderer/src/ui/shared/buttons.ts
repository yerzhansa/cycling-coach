const BUTTON_LAYOUT =
  "relative inline-flex flex-none items-center justify-center rounded-ctl border whitespace-nowrap py-0 font-medium leading-none transition-[background-color,border-color,box-shadow] duration-[120ms] ease-[ease] cursor-pointer disabled:cursor-default disabled:opacity-64 disabled:pointer-events-none aria-disabled:cursor-default aria-disabled:opacity-64 aria-disabled:pointer-events-none motion-reduce:transition-none";

const BUTTON_BASE = `${BUTTON_LAYOUT} gap-1.5`;

const BUTTON_SM = `${BUTTON_BASE} h-ctl-sm px-[9px] text-[13px]`;

const BUTTON_COMPACT_SM = `${BUTTON_LAYOUT} h-ctl-sm px-[9px] text-[13px]`;

const BUTTON_QUIET_STYLE =
  "border-transparent bg-transparent text-ink-2 hover:bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] hover:text-ink";

export const BUTTON_SOLID_SM = `${BUTTON_SM} border-ink bg-ink text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--ink)_90%,var(--bg))]`;

export const BUTTON_OUTLINE_SM = `${BUTTON_SM} border-ink-2 bg-surface text-ink shadow-[var(--edge),var(--elev-1)] hover:bg-surface-2`;

export const BUTTON_QUIET_SM = `${BUTTON_SM} ${BUTTON_QUIET_STYLE}`;

export const BUTTON_COMPACT_QUIET_SM = `${BUTTON_COMPACT_SM} ${BUTTON_QUIET_STYLE}`;

const BUTTON_DANGER_QUIET_STYLE =
  "border-transparent bg-transparent text-danger hover:bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]";

export const BUTTON_DANGER_QUIET_SM = `${BUTTON_SM} ${BUTTON_DANGER_QUIET_STYLE}`;

export const BUTTON_DANGER_SOLID_SM = `${BUTTON_SM} border-danger bg-danger text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--danger)_90%,var(--ink))]`;

export const BUTTON_PRIMARY = `${BUTTON_BASE} h-ctl-lg gap-2 px-[14px] text-sm border-ink bg-ink text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--ink)_90%,var(--bg))]`;
