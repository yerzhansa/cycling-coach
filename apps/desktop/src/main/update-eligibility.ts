import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStableCalVer } from "@enduragent/core";

const PACKAGE_JSON_LIMIT = 64 * 1024;

export function isDesktopUpdateReleaseEligible(input: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly securitySmokeMode: boolean;
  readonly appPath: string;
  readonly currentVersion: string;
  readonly readPackageJson?: (path: string) => string;
}): boolean {
  if (
    !input.isPackaged ||
    input.platform !== "darwin" ||
    input.securitySmokeMode ||
    !isStableCalVer(input.currentVersion)
  ) {
    return false;
  }
  try {
    const raw = (input.readPackageJson ?? ((path) => readFileSync(path, "utf8")))(
      join(input.appPath, "package.json"),
    );
    if (raw.length > PACKAGE_JSON_LIMIT) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const metadata = parsed as Record<string, unknown>;
    return (
      Object.hasOwn(metadata, "enduragentDesktopRelease") &&
      metadata.enduragentDesktopRelease === true &&
      Object.hasOwn(metadata, "version") &&
      metadata.version === input.currentVersion &&
      isStableCalVer(metadata.version)
    );
  } catch {
    return false;
  }
}
