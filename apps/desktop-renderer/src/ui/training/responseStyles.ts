import { rideStyles } from "./rideStyles";

export const responseStyles = {
  ...rideStyles,
  distributionFigure:
    "mt-4 [&_figcaption]:mt-2 [&_figcaption]:max-w-[660px] [&_figcaption]:text-xs [&_figcaption]:leading-[1.5] [&_figcaption]:text-ink-3",
  responseFigure:
    "mt-4 [&_figcaption]:mt-2 [&_figcaption]:max-w-[660px] [&_figcaption]:text-xs [&_figcaption]:leading-[1.5] [&_figcaption]:text-ink-3",
  distributionChart: "group/chart block h-auto w-full overflow-visible",
  responseChart: "block h-auto w-full overflow-visible",
  chartAxis: "stroke-line-2 [stroke-width:1] [vector-effect:non-scaling-stroke]",
  chartTick: "fill-ink-3 text-xs tabular-nums",
  distributionBar: "fill-brand opacity-80 group-data-[unit=bpm]/chart:fill-ink-2",
  analysisTableDisclosure:
    "mt-[13px] border-t border-line [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:px-0.5 [&_summary]:pt-[11px] [&_summary]:pb-0.5 [&_summary]:text-xs [&_summary]:leading-[1.4] [&_summary]:font-medium [&_summary]:text-ink-2 [&_summary]:focus-visible:outline-2 [&_summary]:focus-visible:outline-offset-[3px] [&_summary]:focus-visible:outline-brand",
  analysisTableScroller: "mt-2.5 max-h-80 overflow-auto rounded-card border border-line",
  analysisDataTable:
    "w-full border-collapse font-mono text-[10px] leading-[1.4] text-ink-2 tabular-nums [&_th]:border-b [&_th]:border-line [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:whitespace-nowrap [&_td]:border-b [&_td]:border-line [&_td]:px-2.5 [&_td]:py-2 [&_td]:text-left [&_td]:whitespace-nowrap [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-surface [&_thead_th]:text-[9px] [&_thead_th]:font-medium [&_thead_th]:text-ink-3 [&_tbody_tr:last-child>*]:border-b-0 [&_tbody_th]:font-medium",
  responsePoint: "fill-brand stroke-surface [stroke-width:1.5] [vector-effect:non-scaling-stroke]",
  responseFits: "mt-[18px]",
  responseFitsTitle: "m-0 text-sm leading-[1.4] font-semibold text-ink-2",
  responseFitList:
    "mt-[9px] grid list-none grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2 p-0",
  responseFitItem:
    "flex items-center gap-2.5 rounded-card border border-line px-[11px] py-2.5 text-ink-2 data-[curve-kind=zone-2]:[&_.response-fit-line]:border-ink-2 data-[curve-kind=other]:[&_.response-fit-line]:border-ink-3 data-[curve-kind=other]:[&_.response-fit-line]:border-dashed [&>span:last-child]:grid [&>span:last-child]:min-w-0 [&>span:last-child]:gap-0.5 [&_strong]:text-xs [&_strong]:font-semibold [&>span:last-child>span]:text-xs [&>span:last-child>span]:leading-[1.3] [&>span:last-child>span]:text-ink-3 [&>span:last-child>span]:tabular-nums",
  responseFitLine: "response-fit-line flex-[0_0_34px] border-t-[3px] border-brand",
  responseFitNote: "mt-2 max-w-[660px] text-xs leading-[1.5] text-ink-3",
  responseSummary:
    "mt-4 grid grid-cols-[repeat(2,minmax(0,1fr))_auto] items-center gap-3 max-[761px]:grid-cols-2 [&>div]:min-w-0 [&>div]:border-r [&>div]:border-line [&>div]:pr-3 [&_p]:m-0 [&>div>p:last-child]:mt-1 [&>div>p:last-child]:text-xs [&>div>p:last-child]:text-ink-3",
  responseValue: "text-xl leading-6 font-semibold tabular-nums",
  responseCoverage:
    "justify-self-end rounded-chip border border-line-2 px-2 py-[5px] text-xs font-medium text-ink-2 data-[limited=true]:border-brand max-[761px]:col-span-full max-[761px]:justify-self-start",
  responseMeta:
    "mt-3.5 grid grid-cols-3 gap-2.5 max-[761px]:grid-cols-1 [&>div]:min-w-0 [&>div]:rounded-card [&>div]:border [&>div]:border-line [&>div]:p-2.5 [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-ink-3 [&_dd]:mt-[5px] [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-xs [&_dd]:leading-[1.4] [&_dd]:text-ink-2 [&_dd]:tabular-nums",
} as const;
