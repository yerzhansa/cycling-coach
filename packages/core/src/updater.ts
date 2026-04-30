import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export function getCurrentVersion(binaryName: string): string {
  // Installed-binary path: resolve via Node's module-resolution to find the
  // binary package's package.json wherever pnpm/npm placed it.
  try {
    const requireFn = createRequire(import.meta.url);
    const pkgPath = requireFn.resolve(`${binaryName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    // Dev-time fallback: cwd is the repo root which contains the binary's package.json.
    try {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
      return pkg.version;
    } catch {
      return "unknown";
    }
  }
}

export async function checkForUpdate(binaryName: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${binaryName}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    const current = getCurrentVersion(binaryName);
    return {
      current,
      latest: data.version,
      updateAvailable: data.version !== current,
    };
  } catch {
    return null;
  }
}

export function selfUpdate(binaryName: string): void {
  console.log(`Installing ${binaryName}@latest...`);
  execSync(`npm install -g ${binaryName}@latest`, { stdio: "inherit" });
  process.exit(0);
}

export function getKnownTelegramChatIds(dataDir: string): string[] {
  const sessionsDir = join(dataDir, "sessions");
  try {
    return readdirSync(sessionsDir)
      .filter((f) => f.startsWith("telegram:") && f.endsWith(".jsonl"))
      .map((f) => f.replace("telegram:", "").replace(".jsonl", ""));
  } catch {
    return [];
  }
}

const NOTIFIED_VERSION_FILE = "last-notified-version";

export function getLastNotifiedVersion(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, NOTIFIED_VERSION_FILE), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function setLastNotifiedVersion(dataDir: string, version: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, NOTIFIED_VERSION_FILE), version);
  } catch {
    // Non-critical — don't crash the bot
  }
}
