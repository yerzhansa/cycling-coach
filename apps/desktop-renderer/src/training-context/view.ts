import type {
  CyclingTrainingContext,
  TrainingContextUnknownReason,
  UnitsPreference,
  WellnessSeries,
} from "@enduragent/coach-contract";
import type { TrainingContextView, TrainingContextViewState } from "./controller.js";
import {
  formatDateLabel,
  formatPercentage,
  formatSleepDuration,
  formatUtcTimestamp,
  formatWholeNumber,
} from "./format.js";

export const TRAINING_CONTEXT_DRAWER_ID = "training-context-drawer";
export const MAX_VISIBLE_PLAN_ITEMS = 7;

export interface MountedTrainingContextView {
  readonly view: TrainingContextView;
  bind(input: { readonly onUnitsPreferenceChange: (value: UnitsPreference) => void }): void;
  dispose(): void;
}

const unknownCopy: Record<TrainingContextUnknownReason, string> = {
  "not-synced": "Not synced yet",
  "missing-anchor": "No cycling FTP anchor is available",
  "no-platform-load": "No platform Load is available for the last 7 days",
  "no-plan": "No planned cycling workouts are available",
  "insufficient-data": "Not enough persisted data to show this yet",
  "no-wellness": "No wellness readings are available",
};

function paragraph(className: string, value: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = value;
  return node;
}

function section(title: string): { readonly root: HTMLElement; readonly body: HTMLElement } {
  const root = document.createElement("section");
  root.className = "context-panel";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = "context-panel__body";
  root.append(heading, body);
  return { root, body };
}

function renderUnknown(body: HTMLElement, reason: TrainingContextUnknownReason): void {
  body.replaceChildren(paragraph("context-panel__empty", unknownCopy[reason]));
}

function sparkline(series: WellnessSeries): SVGSVGElement | HTMLSpanElement {
  if (series.points.length === 0) {
    const empty = document.createElement("span");
    empty.className = "wellness-empty";
    empty.textContent = "No readings";
    return empty;
  }
  const values = series.points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("wellness-sparkline");
  svg.setAttribute("viewBox", "0 0 120 30");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  const denominator = Math.max(1, series.points.length - 1);
  const points = series.points.map((point, index) => {
    const x = (index / denominator) * 116 + 2;
    const y = minimum === maximum ? 15 : 27 - ((point.value - minimum) / (maximum - minimum)) * 24;
    return `${x},${y}`;
  });
  line.setAttribute("points", points.join(" "));
  svg.append(line);
  return svg;
}

function renderPanels(bodies: readonly HTMLElement[], context: CyclingTrainingContext): void {
  const anchorBody = bodies[0]!;
  switch (context.anchorZones.kind) {
    case "unknown":
      renderUnknown(anchorBody, context.anchorZones.reason);
      break;
    case "computed": {
      const value = paragraph(
        "context-panel__value",
        `${formatWholeNumber(context.anchorZones.anchor.watts)} W`,
      );
      const stale = document.createElement("span");
      stale.className = `context-badge context-badge--${context.anchorZones.anchor.stalenessBand}`;
      const days = Math.floor(context.anchorZones.anchor.ageDays);
      stale.textContent =
        context.anchorZones.anchor.stalenessBand === "fresh"
          ? "Fresh"
          : context.anchorZones.anchor.stalenessBand === "aging"
            ? `Aging · ${days}d`
            : context.anchorZones.anchor.stalenessBand === "stale"
              ? `Stale · ${days}d`
              : `Very stale · ${days}d`;
      const meta = paragraph(
        "context-panel__meta",
        `As of ${formatDateLabel(context.anchorZones.asOf)} · ${context.anchorZones.anchor.source} · ${context.anchorZones.anchor.confidence}`,
      );
      const zonesHeading = document.createElement("h4");
      zonesHeading.textContent = "Power zones";
      const zones = document.createElement("dl");
      zones.className = "zone-list";
      for (const zone of context.anchorZones.zones) {
        const name = document.createElement("dt");
        name.textContent = zone.name;
        if (zone.overlaps) name.className = "zone-list__overlap";
        const range = document.createElement("dd");
        range.textContent = zone.range;
        zones.append(name, range);
      }
      anchorBody.replaceChildren(value, stale, meta, zonesHeading, zones);
      break;
    }
  }

  const loadBody = bodies[1]!;
  switch (context.cyclingLoad.kind) {
    case "unknown":
      renderUnknown(loadBody, context.cyclingLoad.reason);
      break;
    case "computed": {
      const children: Node[] = [
        paragraph("context-panel__value", formatWholeNumber(context.cyclingLoad.value)),
        paragraph("context-panel__meta", "From intervals.icu · 7 days"),
        paragraph(
          "context-panel__support",
          `${context.cyclingLoad.activityCount} cycling activities`,
        ),
      ];
      if (context.cyclingLoad.missingLoadCount > 0) {
        children.push(
          paragraph(
            "context-panel__support",
            `${context.cyclingLoad.missingLoadCount} cycling activities have no platform Load`,
          ),
        );
      }
      loadBody.replaceChildren(...children);
      break;
    }
  }

  const planBody = bodies[2]!;
  switch (context.plan.kind) {
    case "unknown":
      renderUnknown(planBody, context.plan.reason);
      break;
    case "computed": {
      const list = document.createElement("ol");
      list.className = "plan-list";
      for (const item of context.plan.items.slice(0, MAX_VISIBLE_PLAN_ITEMS)) {
        const row = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = item.name ?? "Cycling workout";
        const meta = document.createElement("span");
        meta.textContent = `${formatDateLabel(item.date)} · ${item.workoutType}`;
        row.append(name, meta);
        list.append(row);
      }
      planBody.replaceChildren(list);
      break;
    }
  }

  const adherenceBody = bodies[3]!;
  switch (context.adherence.kind) {
    case "unknown":
      renderUnknown(adherenceBody, context.adherence.reason);
      break;
    case "computed":
      adherenceBody.replaceChildren(
        paragraph("context-panel__value", formatPercentage(context.adherence.ratio)),
        paragraph(
          "context-panel__support",
          `${context.adherence.matchedDays}/${context.adherence.plannedDays} planned days matched`,
        ),
        paragraph(
          "context-panel__meta",
          `${context.adherence.completedDays} completed days · As of ${formatDateLabel(context.adherence.asOf)}`,
        ),
      );
      break;
  }

  const wellnessBody = bodies[4]!;
  switch (context.wellnessTrend.kind) {
    case "unknown":
      renderUnknown(wellnessBody, context.wellnessTrend.reason);
      break;
    case "computed": {
      const list = document.createElement("div");
      list.className = "wellness-list";
      const labels = ["HRV", "Sleep", "Resting HR"];
      context.wellnessTrend.series.forEach((series, index) => {
        const row = document.createElement("div");
        row.className = "wellness-row";
        const label = document.createElement("strong");
        label.textContent = labels[index]!;
        const latest = series.points.at(-1);
        const value = document.createElement("span");
        value.className = "wellness-row__value";
        value.textContent =
          latest === undefined
            ? "No readings"
            : series.metric === "sleep"
              ? formatSleepDuration(latest.value)
              : `${formatWholeNumber(latest.value)} ${series.unit}`;
        row.append(label, value, sparkline(series));
        list.append(row);
      });
      wellnessBody.replaceChildren(
        paragraph(
          "context-panel__meta",
          `As of ${formatDateLabel(context.wellnessTrend.asOf)} · 7 mornings`,
        ),
        list,
      );
      break;
    }
  }
}

export function mountTrainingContextView(input: {
  readonly spine: HTMLElement;
  readonly drawer: HTMLDialogElement;
}): MountedTrainingContextView {
  input.drawer.id = TRAINING_CONTEXT_DRAWER_ID;
  input.drawer.setAttribute("aria-label", "Training data");
  input.spine.setAttribute("aria-label", "Training data drawer");
  input.spine.replaceChildren();
  const opener = document.createElement("button");
  opener.type = "button";
  opener.className = "drawer-toggle";
  opener.setAttribute("aria-label", "Open training data");
  opener.setAttribute("aria-controls", TRAINING_CONTEXT_DRAWER_ID);
  opener.setAttribute("aria-expanded", "false");
  const spineCopy = document.createElement("span");
  spineCopy.className = "data-spine__copy";
  spineCopy.textContent = "Live training context";
  opener.append(spineCopy);
  input.spine.append(opener);

  input.drawer.replaceChildren();
  const header = document.createElement("header");
  header.className = "drawer-heading";
  const headingWrap = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = "Training context";
  const metadata = document.createElement("div");
  metadata.className = "drawer-metadata";
  headingWrap.append(heading, metadata);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "drawer-close";
  close.setAttribute("aria-label", "Close training data");
  close.textContent = "×";
  header.append(headingWrap, close);
  const status = paragraph("drawer-status", "Loading training context…");
  const panelDefinitions = [
    "Current cycling anchor",
    "Cycling Load",
    "Plan",
    "Adherence",
    "Wellness trend",
  ];
  const panels = panelDefinitions.map(section);

  const units = document.createElement("fieldset");
  units.className = "units-setting";
  const legend = document.createElement("legend");
  legend.textContent = "Display units";
  const metricLabel = document.createElement("label");
  const metric = document.createElement("input");
  metric.type = "radio";
  metric.name = "display-units";
  metric.value = "metric";
  metricLabel.append(metric, document.createTextNode("Metric · km · kg · W/kg"));
  const imperialLabel = document.createElement("label");
  const imperial = document.createElement("input");
  imperial.type = "radio";
  imperial.name = "display-units";
  imperial.value = "imperial";
  imperialLabel.append(imperial, document.createTextNode("Imperial · mi · lb · W/kg"));
  const unitsHelper = paragraph(
    "units-setting__helper",
    "Distance and body mass follow this setting. Cycling power-to-weight remains W/kg.",
  );
  const unitsStatus = paragraph("units-setting__status", "");
  units.append(legend, metricLabel, imperialLabel, unitsHelper, unitsStatus);
  input.drawer.append(header, status, ...panels.map((panel) => panel.root), units);

  let handler: ((value: UnitsPreference) => void) | undefined;
  let disposed = false;
  const open = (): void => {
    if (disposed || input.drawer.open) return;
    input.drawer.showModal();
    opener.setAttribute("aria-expanded", "true");
    close.focus();
  };
  const shut = (): void => {
    if (input.drawer.open) input.drawer.close();
    opener.setAttribute("aria-expanded", "false");
    opener.focus();
  };
  const cancel = (event: Event): void => {
    event.preventDefault();
    shut();
  };
  const unitsChanged = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.checked) {
      handler?.(target.value as UnitsPreference);
    }
  };
  opener.addEventListener("click", open);
  close.addEventListener("click", shut);
  input.drawer.addEventListener("cancel", cancel);
  units.addEventListener("change", unitsChanged);

  return {
    view: {
      render(state: TrainingContextViewState) {
        if (disposed) return;
        metadata.replaceChildren();
        if (state.metadata !== null) {
          metadata.append(
            paragraph(
              "drawer-metadata__item",
              `As of ${formatDateLabel(state.metadata.lastUpdated)}`,
            ),
            paragraph("context-badge", state.metadata.freshness),
          );
          if (state.metadata.degraded) {
            metadata.append(paragraph("drawer-metadata__item", "Data may be incomplete"));
          }
          if (state.metadata.lastSynced !== null) {
            const formatted = formatUtcTimestamp(state.metadata.lastSynced);
            const item = paragraph("drawer-metadata__item", `Last synced ${formatted}`);
            if (formatted !== "Unknown sync time") {
              const time = document.createElement("time");
              time.dateTime = new Date(state.metadata.lastSynced).toISOString();
              time.textContent = formatted;
              item.replaceChildren("Last synced ", time);
            }
            metadata.append(item);
          }
        }
        status.textContent =
          state.status === "loading"
            ? "Loading training context…"
            : state.status === "unavailable"
              ? "Training context unavailable"
              : state.status === "refresh-unavailable"
                ? "Refresh unavailable"
                : "";
        status.hidden = state.status === "ready";
        renderPanels(
          panels.map((panel) => panel.body),
          state.trainingContext,
        );
        metric.checked = state.unitsPreference.value === "metric";
        imperial.checked = state.unitsPreference.value === "imperial";
        const saving = state.unitsPreference.status === "saving";
        metric.disabled = saving || state.unitsPreference.status === "loading";
        imperial.disabled = saving || state.unitsPreference.status === "loading";
        unitsStatus.textContent = saving
          ? "Saving units…"
          : state.unitsPreference.status === "unavailable"
            ? "Units preference unavailable"
            : "";
      },
    },
    bind(next) {
      handler = next.onUnitsPreferenceChange;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handler = undefined;
      opener.removeEventListener("click", open);
      close.removeEventListener("click", shut);
      input.drawer.removeEventListener("cancel", cancel);
      units.removeEventListener("change", unitsChanged);
    },
  };
}
