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

export function isDesktopUpdateAvailable(candidate: string, current: string): boolean {
  const candidateParts = stableSemVerParts(candidate);
  const currentParts = stableSemVerParts(current);
  if (candidateParts === null || currentParts === null) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}
