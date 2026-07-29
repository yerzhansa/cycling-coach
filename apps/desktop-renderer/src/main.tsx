import "./theme/tokens.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { bootRenderer, type Disposer } from "./boot.js";
import { bootTheme, useEnduragentStore } from "./state/store.js";

bootTheme();

const container = document.querySelector("#root");
if (!(container instanceof HTMLElement)) {
  throw new TypeError("Desktop shell host is invalid: #root");
}

let runtime: Disposer | undefined;
let booting = false;

function onReady(): void {
  if (booting || runtime !== undefined) return;
  booting = true;
  queueMicrotask(() => {
    runtime = bootRenderer();
    useEnduragentStore.getState().markRuntimeReady();
  });
}

createRoot(container).render(<App onReady={onReady} />);
