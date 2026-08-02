export const CODEX_VERSION_FLOOR = "0.46.0";
export const CODEX_SCHEMA_PIN = "0.146.0";

interface ParsedVersion {
  readonly release: readonly number[];
  readonly prerelease: readonly string[];
}

function parse(version: string): ParsedVersion {
  const trimmed = version.trim().replace(/^v/, "");
  const withoutBuild = trimmed.split("+")[0] ?? "";
  const dash = withoutBuild.indexOf("-");
  const releasePart = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleasePart = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const release = releasePart.split(".").map((part) => {
    const digits = /^\d+/.exec(part);
    return digits === null ? 0 : Number.parseInt(digits[0], 10);
  });
  const prerelease = prereleasePart === "" ? [] : prereleasePart.split(".");
  return { release, prerelease };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const l = Number.parseInt(left, 10);
    const r = Number.parseInt(right, 10);
    return l === r ? 0 : l < r ? -1 : 1;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.release.length, right.release.length);
  for (let i = 0; i < length; i++) {
    const l = left.release[i] ?? 0;
    const r = right.release[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const identifiers = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < identifiers; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const outcome = compareIdentifiers(l, r);
    if (outcome !== 0) return outcome;
  }
  return 0;
}
