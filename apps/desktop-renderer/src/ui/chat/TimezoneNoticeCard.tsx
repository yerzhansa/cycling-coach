import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import { BUTTON_OUTLINE_SM, BUTTON_SOLID_SM } from "../shared/buttons.js";

export function TimezoneNoticeCard(): ReactElement | null {
  const notice = useEnduragentStore((store) => store.sessionTimezoneNotice);
  const actions = useEnduragentStore((store) => store.sessionTimezoneActions);

  if (notice.status === "hidden") return null;

  const busy = notice.status === "answering";

  return (
    <section
      className="mx-auto my-6 grid w-[min(680px,calc(100%-48px))] grid-cols-[10px_minmax(0,1fr)] gap-3.5 rounded-xl border border-line bg-surface p-5 shadow-[var(--edge),var(--elev-1)] max-[760px]:w-[calc(100%-32px)]"
      data-timezone-notice={notice.status}
      aria-labelledby="timezone-notice-title"
    >
      <div className="mt-[5px] h-2.5 w-2.5 rounded-full bg-ink-2" aria-hidden="true" />
      <div>
        <p className="m-0 text-xs font-semibold tracking-[0.08em] text-ink-2 uppercase">
          Check your timezone
        </p>
        <h2 id="timezone-notice-title" className="mt-[7px] mb-1.5 text-lg leading-[1.3]">
          This computer says {notice.host}
        </h2>
        <p className="m-0 text-sm leading-normal text-ink-2">
          Enduragent has been using {notice.stored} for your training days. Your answer is saved as
          the timezone source in Settings, under Conversation &amp; time, and you can change it
          there any time.
        </p>
        {notice.status === "failed" ? (
          <p className="mt-2 mb-0 text-sm leading-normal text-danger" role="status">
            That did not save. Try again.
          </p>
        ) : null}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BUTTON_OUTLINE_SM}
            disabled={busy}
            onClick={() => actions?.keepStored()}
          >
            Keep {notice.stored}
          </button>
          <button
            type="button"
            className={BUTTON_SOLID_SM}
            disabled={busy}
            onClick={() => actions?.useHost()}
          >
            Follow this computer ({notice.host})
          </button>
        </div>
      </div>
    </section>
  );
}
