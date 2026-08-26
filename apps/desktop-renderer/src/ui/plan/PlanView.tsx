import { CalendarDays, RotateCw } from "lucide-react";
import { useEffect, type ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { useEnduragentStore } from "../../state/store.js";
import { Page } from "../shared/Page.js";

function dateLabel(dateKey: number): string {
  const value = String(dateKey);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)))),
  );
}

function durationLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  return `${Math.round(seconds / 60)} min`;
}

export function PlanView(): ReactElement {
  const surface = useEnduragentStore((state) => state.planSurface);
  const focus = useEnduragentStore((state) => state.planFocus);
  const returnToChat = useEnduragentStore((state) => state.planReturnToChat);
  const actions = useEnduragentStore((state) => state.planActions);

  useEffect(() => {
    actions?.refresh();
  }, [actions]);

  return (
    <Page
      title="Your training plan"
      action={
        <div className="flex gap-2">
          {returnToChat ? (
            <Button variant="outline" onClick={() => actions?.backToChat()}>
              Back to Chat
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => actions?.refresh()} disabled={actions === null}>
            <RotateCw aria-hidden="true" /> Refresh
          </Button>
        </div>
      }
    >
      <p className="mt-0 mb-5 text-sm text-ink-2">
        Planning-owned schedule and current week. Chat can read this information but cannot change it.
      </p>
      {surface.status === "loading" ? (
        <p className="text-sm text-ink-2" role="status">Loading Plan…</p>
      ) : surface.status === "unavailable" && surface.value === null ? (
        <section className="rounded-card border border-line bg-surface p-6">
          <h2 className="m-0 text-base font-semibold">Plan is temporarily unavailable</h2>
          <p className="mt-2 mb-0 text-sm text-ink-2">Your saved Plan is unchanged. Try again.</p>
        </section>
      ) : surface.value?.status === "no-plan" ? (
        <section className="rounded-card border border-line bg-surface p-6">
          <CalendarDays className="mb-3 text-ink-2" aria-hidden="true" />
          <h2 className="m-0 text-base font-semibold">No current Plan</h2>
          <p className="mt-2 mb-0 text-sm text-ink-2">Create and approve plans from the Plan workflow.</p>
        </section>
      ) : (
        <div className="grid gap-4" data-plan-focus={focus?.focus ?? "active-plan"}>
          {surface.status === "unavailable" ? (
            <p className="m-0 rounded-ctl bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
              Showing the last saved Plan; refresh is unavailable.
            </p>
          ) : null}
          <section className="rounded-card border border-line bg-surface p-6 shadow-elev-1">
            <p className="m-0 text-xs font-semibold tracking-[0.06em] text-ink-2 uppercase">
              Current Plan
            </p>
            <h2 className="mt-2 mb-0 text-xl font-semibold">{surface.value!.plan!.name}</h2>
            <p className="mt-2 mb-0 text-sm text-ink-2">{surface.value!.plan!.goal || "No goal recorded"}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-ink-2">
              <span className="rounded-pill bg-surface-2 px-3 py-1.5">
                {surface.value!.plan!.currentWeek === null
                  ? "Outside active dates"
                  : `Week ${surface.value!.plan!.currentWeek} of ${surface.value!.plan!.totalWeeks}`}
              </span>
              {surface.value!.plan!.phase === null ? null : (
                <span className="rounded-pill bg-surface-2 px-3 py-1.5">{surface.value!.plan!.phase}</span>
              )}
            </div>
          </section>
          <section className="rounded-card border border-line bg-surface p-6">
            <h2 className="m-0 text-base font-semibold">Current week</h2>
            {surface.value!.plan!.workouts.length === 0 ? (
              <p className="mt-3 mb-0 text-sm text-ink-2">No workouts in the current Plan week.</p>
            ) : (
              <div className="mt-4 grid gap-2">
                {surface.value!.plan!.workouts.map((workout) => (
                  <article
                    key={workout.id}
                    className={`rounded-ctl border p-4 ${focus?.entityId === workout.id ? "border-brand bg-brand/5" : "border-line bg-surface-2"}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="m-0 text-sm font-semibold">{workout.name}</h3>
                        <p className="mt-1 mb-0 text-xs text-ink-2">
                          {[dateLabel(workout.dateKey), durationLabel(workout.durationSeconds), workout.sport]
                            .filter((item) => item !== null)
                            .join(" · ")}
                        </p>
                      </div>
                      <span className="rounded-pill bg-surface px-2.5 py-1 text-xs text-ink-2">
                        {workout.origin === "athlete" ? "Athlete" : "Coach"}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Page>
  );
}
