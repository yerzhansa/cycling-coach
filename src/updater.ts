import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const PACKAGE_NAME = "cycling-coach";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export function getCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"));
  return pkg.version;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    const current = getCurrentVersion();
    return {
      current,
      latest: data.version,
      updateAvailable: data.version !== current,
    };
  } catch {
    return null;
  }
}

export function selfUpdate(): void {
  console.log("Installing cycling-coach@latest...");
  execSync(`npm install -g ${PACKAGE_NAME}@latest`, { stdio: "inherit" });
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
