import { TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.js";
import { planReadModel } from "../../state/plan-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { Page } from "../shared/Page.js";

const SUPPORT_PAIR = "grid gap-[calc(var(--inset)/2)]";

function RetryButton(): ReactElement | null {
  const actions = useEnduragentStore((state) => state.planActions);
  if (actions === null) return null;
  return (
    <Button type="button" variant="outline" onClick={() => actions.retry()}>
      Retry
    </Button>
  );
}

function StatusCard(props: {
  readonly title: string;
  readonly support: string;
  readonly retry?: boolean;
}): ReactElement {
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-base font-medium">{props.title}</h2>
        <p className="m-0 text-ink-2">{props.support}</p>
      </div>
      {props.retry === true ? <div className="pt-row"><RetryButton /></div> : null}
    </section>
  );
}

function StaleNotice(props: { readonly message: string }): ReactElement {
  return (
    <div
      className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3 text-warn"
      role="status"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="m-0 text-ink-2">{props.message}</p>
    </div>
  );
}

function NoPlan(): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const startGuard = model?.transitions.find((guard) => guard.transitionId === "PL-T01");
  const startBlocked = startGuard?.status === "blocked";
  const busy = transition.status === "submitting" || transition.status === "running";
  const failed = transition.status === "failed";

  return (
    <div className="grid gap-6" data-plan-scenario="PL-S001">
      <section className={SUPPORT_PAIR}>
        <h2 className="m-0 text-lg font-semibold">Train toward one clear goal</h2>
        <p className="m-0 text-ink-2">
          Your coach will ask here for your Goal Event, optional GPX/FIT Race Course, weekly
          availability, and FTP. Nothing writes until you approve.
        </p>
      </section>
      <section className="grid gap-inset">
        <h2 className="m-0 text-sm font-medium">What the draft needs</h2>
        <div className="overflow-hidden rounded-card bg-surface px-5 shadow-elev-1">
          <div className={`${SUPPORT_PAIR} py-3.5`}>
            <h3 className="m-0 text-sm font-medium">Goal event + Race Course</h3>
            <p className="m-0 text-ink-2">Race date, priority, and optional GPX/FIT file</p>
          </div>
          <div className="h-px bg-line" />
          <div className={`${SUPPORT_PAIR} py-3.5`}>
            <h3 className="m-0 text-sm font-medium">Current training</h3>
            <p className="m-0 text-ink-2">
              Recent workouts, recovery, and weekly availability
            </p>
          </div>
          <div className="h-px bg-line" />
          <div className={`${SUPPORT_PAIR} py-3.5`}>
            <h3 className="m-0 text-sm font-medium">FTP</h3>
            <p className="m-0 text-ink-2">
              Athlete-entered FTP, Intervals FTP, or Intervals eFTP
            </p>
          </div>
        </div>
      </section>
      {failed ? (
        <StaleNotice message={transition.error.message} />
      ) : null}
      {startBlocked && startGuard.reason !== null ? (
        <StaleNotice message={startGuard.reason} />
      ) : null}
      <div>
        <Button
          type="button"
          disabled={actions === null || busy || startBlocked}
          aria-busy={busy ? "true" : undefined}
          onClick={() => actions?.startPlan()}
        >
          {busy ? "Opening coach…" : "Build a plan with coach"}
        </Button>
        {failed ? (
          <Button type="button" variant="outline" className="ml-inset" onClick={() => actions?.retry()}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AttentionProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  if (model === null) return <StatusCard title="Plan attention" support="Refreshing your Plan…" />;
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-base font-medium">Plan attention</h2>
        <p className="m-0 text-ink-2">
          {model.attention.count} {model.attention.count === 1 ? "item needs" : "items need"} your
          decision.
        </p>
      </div>
      <div className="grid divide-y divide-line">
        {model.attention.items.map((item) => (
          <p key={item.id} className="m-0 py-3 text-sm">
            {item.title}
          </p>
        ))}
      </div>
    </section>
  );
}

function ReadyProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  if (model === null) return <StatusCard title="Plan" support="Refreshing your Plan…" />;
  if (model.lifecycle === "none" || model.projection === "no-plan") return <NoPlan />;
  if (model.projection === "attention") return <AttentionProjection />;
  return (
    <StatusCard
      title={model.title.length > 0 ? model.title : "Your Plan"}
      support={model.summary.length > 0 ? model.summary : "Your Plan is available."}
    />
  );
}

export function PlanView(): ReactElement {
  const plan = useEnduragentStore((state) => state.plan);
  const model = planReadModel(plan);
  const loading = plan.hydration.status === "loading";
  const subtitle =
    loading
      ? "Loading…"
      : model?.lifecycle === "none"
        ? "No active plan"
        : plan.transition.status === "running" || plan.transition.status === "submitting"
          ? "Working…"
          : undefined;

  return (
    <Page title="Plan" subtitle={subtitle} busy={loading} className="plan-view">
      <div className="grid gap-6">
        {plan.hydration.status === "stale" ? (
          <StaleNotice message={plan.hydration.error.message} />
        ) : null}
        {plan.hydration.status === "loading" ? (
          <p className="m-0 text-ink-2" role="status" aria-live="polite">
            Loading your Plan…
          </p>
        ) : plan.hydration.status === "failed" ? (
          <StatusCard
            title="Plan could not load"
            support={plan.hydration.error.message}
            retry={plan.hydration.error.retryable}
          />
        ) : plan.hydration.status === "unsupported-capability" ? (
          <StatusCard
            title="Plan is not available yet"
            support="Update Enduragent and its local service to use Plan."
          />
        ) : (
          <ReadyProjection />
        )}
      </div>
    </Page>
  );
}
