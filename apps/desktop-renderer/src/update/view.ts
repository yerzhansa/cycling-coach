import type { DesktopUpdateState, DesktopUpdateView } from "./controller.js";

export function createDesktopUpdateView(input: {
  readonly document: Document;
  readonly actionHost: HTMLElement;
  readonly before?: Node | null;
}): DesktopUpdateView {
  const root = input.document.createElement("div");
  root.className = "desktop-update";
  root.hidden = true;
  const button = input.document.createElement("button");
  button.type = "button";
  button.className = "desktop-update__button";
  button.disabled = true;
  const status = input.document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  root.append(button, status);
  input.actionHost.insertBefore(root, input.before ?? null);

  let disposed = false;
  let handler: (() => void) | undefined;
  const onClick = (): void => {
    if (!disposed && !button.disabled) handler?.();
  };
  button.addEventListener("click", onClick);

  const setCopy = (copy: string, label = copy, announcement = label): void => {
    button.textContent = copy;
    button.title = label;
    button.setAttribute("aria-label", label);
    status.textContent = announcement;
  };

  return {
    bind(nextHandler) {
      handler = nextHandler;
    },
    render(state: DesktopUpdateState, options) {
      if (disposed) return;
      root.hidden = state.status === "disabled";
      button.disabled =
        options?.actionDisabled === true ||
        ["disabled", "checking", "downloading", "installing"].includes(state.status);
      switch (state.status) {
        case "disabled":
          setCopy("Updates unavailable");
          break;
        case "idle":
          setCopy("Check for updates");
          break;
        case "current":
          setCopy("Check for updates", "Check for updates", "Enduragent is up to date");
          break;
        case "checking":
          setCopy("Checking…", "Checking for updates");
          break;
        case "downloading":
          setCopy("Downloading…", `Downloading update ${state.version}`);
          break;
        case "downloaded":
          setCopy("Restart to update", `Restart to update to version ${state.version}`);
          break;
        case "installing":
          setCopy("Restarting…", `Restarting to install version ${state.version}`);
          break;
        case "failed":
          setCopy(
            "Try update again",
            "Try update again",
            state.stage === "download"
              ? "Update download failed. Try again"
              : "Update check failed. Try again",
          );
          break;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handler = undefined;
      button.removeEventListener("click", onClick);
      root.remove();
    },
  };
}
