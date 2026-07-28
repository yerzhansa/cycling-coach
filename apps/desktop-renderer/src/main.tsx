import "./theme/tokens.css";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/source-serif-4/wght-italic.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { bootLegacy, type Disposer, type LegacyHosts } from "./legacy-boot.js";
import { bootTheme, useEnduragentStore } from "./state/store.js";

bootTheme();

const container = document.querySelector("#root");
if (!(container instanceof HTMLElement)) {
  throw new TypeError("Desktop shell host is invalid: #root");
}

let legacy: Disposer | undefined;

function onHostsReady(hosts: LegacyHosts): void {
  if (legacy !== undefined) return;
  legacy = bootLegacy(hosts);
  useEnduragentStore.getState().markLegacyReady();
}

createRoot(container).render(<App onHostsReady={onHostsReady} />);
