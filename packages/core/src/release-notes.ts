import { readBinaryPackageJson, type UpdateInfo } from "./updater.js";

export interface RepoInfo {
  owner: string;
  name: string;
}

export function parseRepoFromUrl(url: string): RepoInfo | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:#.*)?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

export function getRepoForBinary(binaryName: string): RepoInfo | null {
  const pkg = readBinaryPackageJson(binaryName);
  const repo = pkg?.repository as { url?: string } | string | undefined;
  const url = typeof repo === "string" ? repo : repo?.url;
  return url ? parseRepoFromUrl(url) : null;
}

export function parseUserFacing(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const m = raw.match(/User-facing:\s*(.+?)\s*$/i);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

export async function fetchReleaseBody(
  repo: RepoInfo,
  tag: string,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/releases/tags/${encodeURIComponent(tag)}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { body?: string };
    return data.body ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the `/whatsnew` reply for the latest published version of `binaryName`.
 * Always shows the latest version's notes (per product decision) — when the
 * user is up to date that's their version's notes; when behind, it's a preview
 * of what `/update` will install. Renders only `User-facing:` lines extracted
 * from the GitHub Release body; engineering details and changeset hashes never
 * surface to athletes.
 */
export async function buildWhatsNewMessage(binaryName: string, info: UpdateInfo): Promise<string> {
  const repo = getRepoForBinary(binaryName);
  if (!repo) {
    return `Couldn't locate the GitHub repository for ${binaryName}.`;
  }

  const tag = `${binaryName}@${info.latest}`;
  const releaseUrl = `https://github.com/${repo.owner}/${repo.name}/releases/tag/${tag}`;
  const body = await fetchReleaseBody(repo, tag);

  const lines: string[] = [];
  lines.push(`**What's new in ${info.latest}**`);
  lines.push("");

  if (body === null) {
    lines.push(`Couldn't fetch release notes from GitHub. See ${releaseUrl}`);
  } else {
    const userFacing = parseUserFacing(body);
    if (userFacing.length > 0) {
      for (const line of userFacing) lines.push(`- ${line}`);
    } else {
      lines.push(`_No athlete-facing summary written for this release._`);
      lines.push(`Full notes: ${releaseUrl}`);
    }
  }

  lines.push("");
  if (info.updateAvailable) {
    lines.push(`You're on ${info.current}. Send /update to install ${info.latest}.`);
  } else {
    lines.push(`You're up to date.`);
  }

  return lines.join("\n");
}
