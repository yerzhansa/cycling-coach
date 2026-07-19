import type { App, LoginItemSettings } from "electron";

export const CLEAN_LOGIN_ITEM_STATUSES = ["not-found", "not-registered"] as const;

export type CleanLoginItemStatus = (typeof CLEAN_LOGIN_ITEM_STATUSES)[number];

export interface LoginItemResidencyState {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin: boolean;
  readonly status: LoginItemSettings["status"];
}

export type LoginItemAppPort = Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;

export function readLoginItemResidency(app: LoginItemAppPort): LoginItemResidencyState {
  const settings = app.getLoginItemSettings();
  return {
    openAtLogin: settings.openAtLogin,
    executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
    status: settings.status,
  };
}

export function setLoginItemResidency(
  app: LoginItemAppPort,
  openAtLogin: boolean,
): LoginItemResidencyState {
  app.setLoginItemSettings({ openAtLogin });
  return readLoginItemResidency(app);
}

export function isCleanUnregisteredLoginItem(
  state: LoginItemResidencyState,
): state is LoginItemResidencyState & {
  readonly openAtLogin: false;
  readonly executableWillLaunchAtLogin: false;
  readonly status: CleanLoginItemStatus;
} {
  return (
    state.openAtLogin === false &&
    state.executableWillLaunchAtLogin === false &&
    CLEAN_LOGIN_ITEM_STATUSES.includes(state.status as CleanLoginItemStatus)
  );
}
