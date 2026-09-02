export const overviewStyles = {
  periodGroup:
    "mb-4 flex items-center gap-1.5 [&_button]:h-ctl-sm [&_button]:rounded-ctl [&_button]:border [&_button]:border-line-2 [&_button]:bg-surface [&_button]:px-ctl-px-sm [&_button]:text-xs [&_button]:font-medium [&_button]:text-ink-2 [&_button]:outline-none [&_button]:transition-colors [&_button]:hover:bg-surface-2 [&_button]:hover:text-ink [&_button]:focus-visible:border-ring [&_button]:focus-visible:ring-3 [&_button]:focus-visible:ring-ring/20 [&_button]:disabled:cursor-default [&_button]:disabled:opacity-64 [&_button]:aria-pressed:border-brand [&_button]:aria-pressed:bg-brand-soft [&_button]:aria-pressed:text-brand motion-reduce:[&_button]:transition-none",
  dataNotice:
    "mb-[18px] border-l-[3px] border-warn bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] px-[11px] py-[9px] text-xs leading-5 text-ink-2",
  weekSection: "mb-7 min-w-0",
  weekHeading:
    "mb-3.5 flex min-w-0 items-baseline justify-between gap-3 max-[520px]:grid [&_h2]:m-0 [&_h2]:text-lg [&_h2]:leading-7 [&_h2]:font-semibold [&_p]:m-0 [&_p]:text-xs [&_p]:leading-4 [&_p]:text-ink-3",
  weekHero:
    "grid min-w-0 grid-cols-[minmax(210px,0.82fr)_minmax(0,1.18fr)] items-stretch gap-6 max-[761px]:grid-cols-1 max-[761px]:gap-[18px]",
  weekFacts: "min-w-0",
  weekEyebrow: "m-0 text-xs leading-4 font-semibold text-ink-3",
  weekTime:
    "mt-2 [overflow-wrap:anywhere] text-2xl leading-8 font-semibold tracking-normal tabular-nums",
  weekMetrics:
    "mt-2.5 flex min-w-0 flex-wrap gap-x-[18px] gap-y-2 [&>div]:min-w-0 [&_dt]:text-xs [&_dt]:leading-4 [&_dt]:text-ink-3 [&_dd]:mt-0.5 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-sm [&_dd]:leading-5 [&_dd]:font-medium [&_dd]:tabular-nums",
  trend:
    "m-0 grid min-w-0 grid-rows-[auto_1fr] gap-2.5 border-l border-line pl-6 max-[761px]:border-t max-[761px]:border-l-0 max-[761px]:pt-3.5 max-[761px]:pl-0",
  trendCaption: "text-xs leading-4 font-medium text-ink-2",
  trendBars:
    "grid min-h-[92px] grid-cols-6 items-end gap-inset border-b border-line max-[761px]:min-h-[76px]",
  trendColumn: "grid h-full min-w-0 grid-rows-[1fr_auto] items-end gap-1",
  trendBar: "training-trend-bar w-full rounded-t-chip bg-line-2",
  trendLabel:
    "overflow-hidden text-center text-xs leading-4 text-ink-3 text-ellipsis whitespace-nowrap",
  trendUnavailable: "mt-2 text-sm leading-5 font-medium text-ink",
  trendReason: "mt-1 text-xs leading-5 text-ink-2",
  ridesSection: "mb-7 min-w-0 [&>h2]:mb-2.5 [&>h2]:text-lg [&>h2]:leading-7 [&>h2]:font-semibold",
  historyRideList: "m-0 list-none p-0",
  historyRideItem: "group/callout border-t border-line last:border-b",
  historyRideButton:
    "group/ride relative grid min-h-[78px] w-full min-w-0 grid-cols-[58px_minmax(0,1fr)_auto_18px] items-center gap-3.5 bg-transparent px-inset py-row text-left text-ink outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink group-data-[callout=true]/callout:bg-[color-mix(in_srgb,var(--brand-soft)_58%,transparent)] motion-reduce:transition-none max-[761px]:grid-cols-[46px_minmax(0,1fr)_18px] max-[761px]:gap-row",
  historyRideDate:
    "grid gap-0.5 text-center text-xs leading-4 text-ink-3 [&>strong]:text-lg [&>strong]:leading-7 [&>strong]:font-semibold [&>strong]:text-ink [&>strong]:tabular-nums",
  historyRideMain: "grid min-w-0 gap-1",
  historyRideTitle:
    "flex min-w-0 flex-wrap items-center gap-inset [&>strong]:overflow-hidden [&>strong]:text-sm [&>strong]:leading-5 [&>strong]:font-semibold [&>strong]:text-ellipsis [&>strong]:whitespace-nowrap [&>span]:inline-flex [&>span]:min-h-5 [&>span]:items-center [&>span]:rounded-chip [&>span]:bg-brand-soft [&>span]:px-1.5 [&>span]:text-xs [&>span]:leading-4 [&>span]:font-medium [&>span]:text-brand",
  historyRideMeta:
    "overflow-hidden text-xs leading-4 text-ink-3 text-ellipsis whitespace-nowrap max-[761px]:hidden",
  historyRideReason:
    "overflow-hidden text-xs leading-4 font-medium text-brand text-ellipsis whitespace-nowrap",
  historyRideStats:
    "grid grid-cols-[repeat(2,auto)] gap-x-[18px] gap-y-1 text-right text-xs leading-4 text-ink-2 tabular-nums [&>strong]:font-medium [&>strong]:text-ink max-[761px]:col-start-2 max-[761px]:row-start-2 max-[761px]:justify-start max-[761px]:text-left",
  historyRideArrow:
    "grid place-items-center text-base leading-6 text-ink-3 transition-transform group-hover/ride:translate-x-0.5 motion-reduce:transition-none max-[761px]:col-start-3 max-[761px]:row-span-2 max-[761px]:row-start-1",
  historyEmpty: "m-0 py-3.5 text-sm leading-5 text-ink-2",
  truncation: "mt-3 text-xs leading-5 text-ink-3",
  importStatus: "mt-7 border-t border-line pt-3.5 [&>h2]:m-0 [&>h2]:text-sm [&>h2]:font-semibold",
  panel: "mb-3.5 rounded-card border border-line bg-surface px-[18px] py-4 shadow-elev-1 last:mb-0",
  panelTitle: "m-0 text-xs font-semibold text-ink-3",
  panelBody: "mt-3 min-w-0",
  meta: "m-0 [overflow-wrap:anywhere] text-xs leading-[1.45] text-ink-2",
  support: "mt-2 [overflow-wrap:anywhere] text-sm leading-[1.45] text-ink-2",
  empty: "m-0 text-sm leading-[1.45] text-ink-2",
  srOnly: "sr-only",
  progressNotice:
    "mb-3.5 border-l-[3px] border-warn bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] px-[11px] py-[9px] text-xs leading-6 text-ink-2",
  progressHeader:
    "flex min-w-0 items-start justify-between gap-3 [&>div]:min-w-0 [&_.training-badge]:m-0 [&_.training-badge]:shrink-0",
  progressLead: "mb-[5px] text-sm leading-5 font-semibold text-ink",
  progressTableWrap: "training-progress-table-wrap mt-3.5 min-w-0 overflow-x-auto",
  progressTable:
    "w-full min-w-[390px] border-separate border-spacing-0 tabular-nums [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-[9px] [&_th]:text-right [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-[9px] [&_td]:text-right [&_thead_th]:pt-0 [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:tracking-normal [&_thead_th]:text-ink-3 [&_th:first-child]:pl-0 [&_th:first-child]:text-left [&_td:first-child]:pl-0 [&_td:first-child]:text-left [&_th:last-child]:pr-0 [&_td:last-child]:pr-0 [&_tbody_th]:relative [&_tbody_th]:text-xs [&_tbody_th]:leading-4 [&_tbody_th]:font-semibold [&_tbody_th]:text-ink [&_tbody_th::before]:mr-[9px] [&_tbody_th::before]:inline-block [&_tbody_th::before]:h-[18px] [&_tbody_th::before]:w-[3px] [&_tbody_th::before]:rounded-sm [&_tbody_th::before]:bg-ink [&_tbody_th::before]:align-middle [&_tbody_th::before]:opacity-25 [&_tbody_th::before]:content-[''] [&_tbody_tr:nth-child(1)_th::before]:opacity-100 [&_tbody_tr:nth-child(2)_th::before]:opacity-80 [&_tbody_tr:nth-child(3)_th::before]:opacity-60 [&_tbody_tr:nth-child(4)_th::before]:opacity-40 [&_tbody_td]:text-xs [&_tbody_td]:leading-4 [&_tbody_td]:text-ink-2 [&_tbody_td:nth-child(2)]:font-semibold [&_tbody_td:nth-child(2)]:text-ink",
  progressChange: "data-[tone=positive]:text-ok data-[tone=negative]:text-warn",
  progressDetails:
    "mt-3.5 text-xs text-ink-2 [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary]:focus-visible:outline-2 [&_summary]:focus-visible:outline-offset-[3px] [&_summary]:focus-visible:outline-ink [&_.training-progress-table-wrap]:mt-2.5",
  heartRateTable: "[&_tbody_th::before]:opacity-45",
  progressFoot: "mt-3.5 text-xs leading-6 text-ink-3",
  badge:
    "training-badge mt-1 mb-2 inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-chip bg-surface-2 px-1.5 text-xs font-medium text-ink-2 capitalize data-[band=aging]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[band=aging]:text-warn data-[band=stale]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[band=stale]:text-warn data-[band=very-stale]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[band=very-stale]:text-warn data-[freshness=flag]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[freshness=flag]:text-warn data-[freshness=stale]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[freshness=stale]:text-warn data-[freshness=critical]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[freshness=critical]:text-warn",
  exportControls:
    "mt-3 flex flex-wrap items-center gap-[9px] [&_label]:text-xs [&_label]:font-semibold [&_label]:text-ink-2",
  exportStatus: "mt-2.5 text-xs leading-[1.45] text-ink-2",
  analysisPanel: "mt-3.5 rounded-card border border-line bg-surface p-5 shadow-elev-1",
  analysisTitle: "m-0 text-xl leading-6 font-semibold tracking-normal",
  analysisIntro: "mt-[9px] max-w-[650px] text-xs leading-6 text-ink-2",
} as const;
