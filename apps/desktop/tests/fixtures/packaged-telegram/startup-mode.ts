import type { LoginItemSettings } from "electron";

export const ACCEPTANCE_OS_LOGIN_MARKER_ENV = "ENDURAGENT_ACCEPTANCE_OS_LOGIN_LAUNCH" as const;
export const ACCEPTANCE_OS_LOGIN_MARKER_VALUE = "os-login" as const;

export interface AcceptanceLoginLaunchPort {
  getLoginItemSettings(...args: unknown[]): LoginItemSettings;
}

function installSingleLoginLaunchObservation(
  app: AcceptanceLoginLaunchPort,
  wasOpenedAtLogin: boolean,
): void {
  const key = "getLoginItemSettings";
  const ownDescriptor = Object.getOwnPropertyDescriptor(app, key);
  const original = app.getLoginItemSettings;
  let pending = true;
  const restore = (): void => {
    if (ownDescriptor === undefined) {
      if (!Reflect.deleteProperty(app, key)) {
        throw new TypeError("Telegram acceptance startup port could not be restored");
      }
      return;
    }
    Object.defineProperty(app, key, ownDescriptor);
  };
  Object.defineProperty(app, key, {
    configurable: true,
    writable: true,
    value(...args: unknown[]): LoginItemSettings {
      if (!pending) throw new TypeError("Telegram acceptance startup marker was reused");
      pending = false;
      restore();
      return { ...original.apply(app, args), wasOpenedAtLogin };
    },
  });
}

export function consumeAcceptanceStartupMarker(
  environment: NodeJS.ProcessEnv,
  app: AcceptanceLoginLaunchPort,
): "manual" | "os-login" {
  const marker = environment[ACCEPTANCE_OS_LOGIN_MARKER_ENV];
  delete environment[ACCEPTANCE_OS_LOGIN_MARKER_ENV];
  if (marker === undefined) {
    installSingleLoginLaunchObservation(app, false);
    return "manual";
  }
  if (marker !== ACCEPTANCE_OS_LOGIN_MARKER_VALUE) {
    throw new TypeError("Telegram acceptance startup marker is invalid");
  }
  installSingleLoginLaunchObservation(app, true);
  return "os-login";
}
