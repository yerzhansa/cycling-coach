import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DESKTOP_PACKAGE_JSON = resolve(import.meta.dirname, "../desktop/package.json");

export function desktopAppVersion() {
  try {
    const parsed = JSON.parse(readFileSync(DESKTOP_PACKAGE_JSON, "utf8"));
    return typeof parsed.version === "string" && parsed.version.length > 0
      ? parsed.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function appVersionDefine() {
  return { __ENDURAGENT_APP_VERSION__: JSON.stringify(desktopAppVersion()) };
}
