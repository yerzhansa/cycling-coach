import { Tooltip } from "@base-ui/react/tooltip";
import { Info } from "lucide-react";
import type { ReactElement } from "react";

export function InfoTip(props: {
  readonly label: string;
  readonly lead: string;
  readonly body: string;
}): ReactElement {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        data-info-tip=""
        aria-label={props.label}
        className="grid size-[15px] shrink-0 appearance-none place-items-center bg-transparent p-0 text-ink-3 transition-colors hover:text-ink focus-visible:text-ink motion-reduce:transition-none"
      >
        <Info size={14} strokeWidth={2.25} aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={8}>
          <Tooltip.Popup
            data-info-tip-popup=""
            className="w-[252px] rounded-md border border-line-2 bg-surface px-3 py-2.5 text-xs leading-relaxed text-ink-2 shadow-elev-3"
          >
            <b className="mb-1 block font-medium text-ink">{props.lead}</b>
            {props.body}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
