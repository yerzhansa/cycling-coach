import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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
  const tryParse = (pkgPath: string): RepoInfo | null => {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { repository?: { url?: string } | string };
      const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
      return url ? parseRepoFromUrl(url) : null;
    } catch {
      return null;
    }
  };

  try {
    const requireFn = createRequire(import.meta.url);
    const installed = tryParse(requireFn.resolve(`${binaryName}/package.json`));
    if (installed) return installed;
  } catch {
    // fall through to dev fallback
  }
  return tryParse(join(process.cwd(), "package.json"));
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

export interface WhatsNewArgs {
  binaryName: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export async function buildWhatsNewMessage(args: WhatsNewArgs): Promise<string> {
  const repo = getRepoForBinary(args.binaryName);
  if (!repo) {
    return `Couldn't locate the GitHub repository for ${args.binaryName}.`;
  }

  const tag = `${args.binaryName}@${args.latestVersion}`;
  const releaseUrl = `https://github.com/${repo.owner}/${repo.name}/releases/tag/${tag}`;
  const body = await fetchReleaseBody(repo, tag);

  const lines: string[] = [];
  lines.push(`**What's new in ${args.latestVersion}**`);
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
  if (args.updateAvailable) {
    lines.push(`You're on ${args.currentVersion}. Send /update to install ${args.latestVersion}.`);
  } else {
    lines.push(`You're up to date.`);
  }

  return lines.join("\n");
}
