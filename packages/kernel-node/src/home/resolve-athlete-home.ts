import { homedir } from "node:os";
import { join } from "node:path";

export const ATHLETE_HOME_ENV = "ENDURAGENT_HOME" as const;

export interface AthleteHome {
  /** The athlete home root: `~/.enduragent` by default, or the ENDURAGENT_HOME override. */
  readonly root: string;
  /** App-private, never file-synced. Holds the live derived SQLite DB. */
  readonly storeDir: string;
  /** Sync-safe (iCloud/Syncthing) — content-addressed immutable inputs only. */
  readonly archiveDir: string;
  /** App-private, never file-synced. Holds the single-writer lockfile + port file + bearer token. */
  readonly configDir: string;
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveAthleteHome(
  env: Record<string, string | undefined> = process.env,
): AthleteHome {
  const override = env[ATHLETE_HOME_ENV];
  const root =
    override !== undefined && override.length > 0
      ? expandTilde(override)
      : join(homedir(), ".enduragent");
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}
