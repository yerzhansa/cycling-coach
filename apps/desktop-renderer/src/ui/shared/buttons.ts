const BUTTON_LAYOUT =
  "inline-flex flex-none items-center justify-center rounded-ctl border whitespace-nowrap font-medium transition-colors disabled:opacity-50 motion-reduce:transition-none";

const BUTTON_BASE = `${BUTTON_LAYOUT} gap-1.5`;

const BUTTON_SM = `${BUTTON_BASE} h-ctl-sm px-[9px] text-[13px]`;

const BUTTON_COMPACT_SM = `${BUTTON_LAYOUT} h-ctl-sm px-[9px] text-[13px]`;

const BUTTON_QUIET_STYLE =
  "border-transparent bg-transparent text-ink-2 hover:bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] hover:text-ink";

export const BUTTON_SOLID_SM = `${BUTTON_SM} border-ink bg-ink text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--ink)_90%,var(--bg))]`;

export const BUTTON_OUTLINE_SM = `${BUTTON_SM} border-ink-2 bg-surface text-ink shadow-[var(--edge),var(--elev-1)] hover:bg-surface-2`;

export const BUTTON_QUIET_SM = `${BUTTON_SM} ${BUTTON_QUIET_STYLE}`;

export const BUTTON_COMPACT_QUIET_SM = `${BUTTON_COMPACT_SM} ${BUTTON_QUIET_STYLE}`;

export const BUTTON_DANGER_SM = `${BUTTON_SM} border-[color-mix(in_srgb,var(--danger)_34%,transparent)] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] text-danger shadow-none hover:bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]`;

export const BUTTON_DANGER_OUTLINE_SM = `${BUTTON_COMPACT_SM} border-[color-mix(in_srgb,var(--danger)_34%,transparent)] bg-transparent text-danger hover:bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]`;

export const BUTTON_DANGER_LINK_SM = `${BUTTON_SM} border-transparent bg-transparent text-danger shadow-none hover:bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]`;

export const BUTTON_PRIMARY = `${BUTTON_BASE} h-ctl-lg gap-2 px-[14px] text-sm border-ink bg-ink text-bg shadow-[var(--sheen),var(--elev-1)] hover:bg-[color-mix(in_srgb,var(--ink)_90%,var(--bg))]`;
