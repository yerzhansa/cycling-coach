const MAX_DESKTOP_VERSION_LENGTH = 32;
const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function stableSemVerParts(value: unknown): readonly [number, number, number] | null {
  if (typeof value !== "string" || value.length > MAX_DESKTOP_VERSION_LENGTH) return null;
  const match = STABLE_SEMVER_PATTERN.exec(value);
  if (match === null) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isStableDesktopVersion(value: unknown): value is string {
  return stableSemVerParts(value) !== null;
}

export function compareDesktopVersions(left: string, right: string): -1 | 0 | 1 | null {
  const leftParts = stableSemVerParts(left);
  const rightParts = stableSemVerParts(right);
  if (leftParts === null || rightParts === null) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function isDesktopUpdateAvailable(candidate: string, current: string): boolean {
  return compareDesktopVersions(candidate, current) === 1;
}
