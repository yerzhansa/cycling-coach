import type { SpendRouteSummary, SpendSummary } from "@enduragent/coach-contract";
import type { SpendMeterView } from "./controller.js";

export const SPEND_METER_TRACK_HEIGHT_PX = 3;
export const SPEND_DISCLOSURE_WIDTH_PX = 360;

function currency(value: number, detail = false): string {
  if (value === 0) return "$0.00";
  if (value > 0 && value < 0.01) {
    return detail ? `$${value.toFixed(4)}` : "<$0.01";
  }
  return `$${value.toFixed(2)}`;
}

function localDateLabel(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, month - 1, day)));
}

function node<K extends keyof HTMLElementTagNameMap>(name: K, className?: string) {
  const element = document.createElement(name);
  if (className !== undefined) element.className = className;
  return element;
}

function text<K extends keyof HTMLElementTagNameMap>(name: K, value: string, className?: string) {
  const element = node(name, className);
  element.textContent = value;
  return element;
}

function routeRow(route: SpendRouteSummary): HTMLElement {
  const row = node("article", "spend-route");
  const heading = text("p", `${route.provider} · ${route.model}`, "spend-route__heading");
  const coverage = text(
    "p",
    `${currency(route.knownSpendUsd, true)} · ${route.pricedGenerationCount}/${route.generationCount} generations priced`,
    "spend-route__coverage",
  );
  const cache = text(
    "p",
    route.cacheReadTokens === 0
      ? "No cache reads"
      : route.cacheReadSavingsUsd === null
        ? `${route.cacheReadTokens.toLocaleString("en-US")} cache-read tokens · savings unavailable`
        : `${route.cacheReadTokens.toLocaleString("en-US")} cache-read tokens · Saved ${currency(route.cacheReadSavingsUsd, true)}`,
    "spend-route__cache",
  );
  const caching = text(
    "p",
    route.caching === "explicit"
      ? "Explicit caching on this route."
      : route.caching === "provider-dependent"
        ? "Provider-dependent caching; no explicit breakpoint on this route."
        : (route.disclosure ?? ""),
    "spend-route__caching",
  );
  row.append(heading, coverage, cache, caching);
  return row;
}

export function createSpendMeterView(input: {
  readonly root: HTMLElement;
  readonly noticeHost: HTMLElement;
}): SpendMeterView {
  input.root.replaceChildren();
  input.root.removeAttribute("aria-label");
  input.root.classList.add("spend-meter");

  const details = node("details", "spend-meter__details");
  const summary = node("summary");
  const copy = node("span", "spend-copy");
  const label = text("span", "Today’s spend");
  const amount = text("strong", "—");
  copy.append(label, amount);
  const track = node("span", "meter-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", "Daily spend cap");
  track.setAttribute("aria-valuemin", "0");
  const fill = node("span", "meter-fill");
  track.append(fill);
  summary.append(copy, track);

  const disclosure = node("div", "spend-disclosure");
  disclosure.setAttribute("aria-label", "Spend details");
  const day = text("p", "Today", "spend-disclosure__day");
  const messages = node("div", "spend-disclosure__messages");
  const routes = node("div", "spend-routes");
  const editor = node("div", "spend-cap-editor");
  const capLabel = text("label", "Daily cap (USD)");
  capLabel.htmlFor = "daily-spend-cap";
  const capInput = node("input");
  capInput.id = "daily-spend-cap";
  capInput.type = "number";
  capInput.step = "any";
  capInput.inputMode = "decimal";
  const save = text("button", "Save cap");
  save.type = "button";
  const inputError = text("p", "", "spend-cap-editor__error");
  inputError.setAttribute("role", "status");
  inputError.hidden = true;
  editor.append(capLabel, capInput, save, inputError);
  disclosure.append(day, messages, routes, editor);
  details.append(summary, disclosure);
  input.root.append(details);

  const warning = text("p", "");
  warning.id = "spend-cap-warning";
  warning.setAttribute("role", "status");
  warning.setAttribute("aria-live", "polite");
  warning.hidden = true;
  input.noticeHost.append(warning);

  let saveHandler: (() => void) | undefined;
  let disposed = false;
  let capDirty = false;
  let lastSummary: SpendSummary | undefined;
  const onSave = (): void => saveHandler?.();
  const onCapInput = (): void => {
    capDirty = true;
  };
  save.addEventListener("click", onSave);
  capInput.addEventListener("input", onCapInput);

  const renderSummary = (spend: SpendSummary, options: { readonly stale: boolean }): void => {
    if (disposed) return;
    lastSummary = spend;
    const known = `${currency(spend.knownSpendUsd)}${spend.spendComplete ? "" : "+"}`;
    const cap = currency(spend.dailyCapUsd);
    const ratio = spend.knownSpendUsd / spend.dailyCapUsd;
    input.root.dataset.capStatus = spend.capStatus;
    input.root.title = `${Math.round(ratio * 100)}% of today’s language model budget used`;
    summary.setAttribute("aria-label", `Today's spend: ${known} of ${cap}`);
    amount.textContent = `${known} / ${cap}`;
    track.setAttribute("aria-valuemax", String(spend.dailyCapUsd));
    track.setAttribute("aria-valuenow", String(Math.min(spend.knownSpendUsd, spend.dailyCapUsd)));
    track.setAttribute("aria-valuetext", `${known} of ${cap}`);
    fill.style.width = `${Math.min(1, ratio) * 100}%`;
    day.textContent = `Today · ${localDateLabel(spend.localDate)}`;
    if (!capDirty || Number(capInput.value) === spend.dailyCapUsd) {
      capInput.value = String(spend.dailyCapUsd);
      capDirty = false;
    }
    routes.replaceChildren(...spend.routes.map(routeRow));
    const notices: HTMLElement[] = [];
    if (!spend.spendComplete) {
      notices.push(
        text("p", "Some provider costs are unavailable, so today’s total is a known minimum."),
      );
    }
    if (spend.malformedLineCount > 0) {
      notices.push(text("p", "Some usage records could not be read."));
    }
    notices.push(
      text(
        "p",
        `${spend.cacheSavingsComplete ? "Saved" : "Saved at least"} ${currency(spend.knownCacheReadSavingsUsd, true)} with cache reads`,
      ),
    );
    if (options.stale) notices.push(text("p", "Spend data may be out of date."));
    messages.replaceChildren(...notices);
    warning.hidden = spend.capStatus !== "reached";
    warning.textContent = warning.hidden
      ? ""
      : `You’ve reached today’s ${cap} spend cap. You can keep chatting; this is a warning, not a block.`;
  };

  return {
    renderLoading() {
      if (disposed) return;
      label.textContent = "Today’s spend";
      amount.textContent = "—";
      messages.replaceChildren();
      warning.hidden = true;
      warning.textContent = "";
    },
    renderSummary,
    renderUnavailable({ hadSummary }) {
      if (disposed) return;
      if (hadSummary && lastSummary !== undefined) {
        renderSummary(lastSummary, { stale: true });
        return;
      }
      label.textContent = "Today’s spend";
      amount.textContent = "—";
      input.root.removeAttribute("data-cap-status");
      summary.setAttribute("aria-label", "Today’s spend is not available yet");
      messages.replaceChildren(text("p", "Spend data unavailable."));
      routes.replaceChildren();
      warning.hidden = true;
      warning.textContent = "";
    },
    bindSave(handler) {
      saveHandler = handler;
    },
    readDailyCapUsd() {
      return Number(capInput.value);
    },
    setSaving(saving) {
      save.disabled = saving;
    },
    showCapInputError(message) {
      inputError.hidden = message === null;
      inputError.textContent = message ?? "";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      saveHandler = undefined;
      save.removeEventListener("click", onSave);
      capInput.removeEventListener("input", onCapInput);
      warning.remove();
    },
  };
}
