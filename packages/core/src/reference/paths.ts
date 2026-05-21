import { join } from "node:path";
import { getCoachHome } from "../coach-home.js";

/**
 * Path resolver for Reference's persisted state. Every cache file
 * (`latest.json`, `history.json`, `intervals.json`, `routes.json`,
 * `ftp_history.json`), every coordination file (`.scheduler.json`,
 * `error_state.json`), and the audit log (`.audit.jsonl`) live under
 * `<coach-home>/data/`. Centralizing the `/data` segment here means no
 * Reference module hardcodes the directory name.
 *
 * Pure function: composes `getCoachHome(binaryName)` with `/data`. Does NOT
 * create the directory; callers (notably `runSync`) create it on first use.
 */
export function referenceDataDir(binaryName: string): string {
  return join(getCoachHome(binaryName), "data");
}
