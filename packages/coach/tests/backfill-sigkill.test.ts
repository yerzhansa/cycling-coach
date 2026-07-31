import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const taskRoot = process.cwd();
const childPath = join(taskRoot, "packages/coach/tests/fixtures/backfill-child.ts");
const loader = pathToFileURL(join(taskRoot, "node_modules/tsx/dist/loader.mjs")).href;

function launch(home: string, alignment: string, point: string) {
  return spawn(process.execPath, ["--import", loader, childPath, home, alignment, point], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
}
async function waitFor(child: ReturnType<typeof launch>, token: string, timeout = 10_000): Promise<void> {
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child marker timeout: ${output}`)), timeout);
    child.stdout!.on("data", (value) => { output += String(value); if (output.includes(token)) { clearTimeout(timer); resolve(); } });
    child.stderr!.on("data", (value) => { output += String(value); });
    child.once("exit", (code) => { if (!output.includes(token)) { clearTimeout(timer); reject(new Error(`child exited ${code}: ${output}`)); } });
  });
}
async function waitExit(child: ReturnType<typeof launch>, timeout = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("child exit timeout")), timeout);
    child.once("exit", () => { clearTimeout(timer); resolve(); }); });
}
async function waitGroupExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    if (Date.now() >= deadline) throw new Error("process group survived SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function canonical(home: string): Promise<string> {
  const store = openSqliteStorage(join(home, "store.db")); await runMigrations(store, MIGRATIONS);
  const result = await dumpStore(store); await store.close(); return result;
}

describe("real process-group kill and resume", () => {
  it("kills all five transaction boundaries across four page alignments", { timeout: 240_000 }, async () => {
    const points = ["before-begin", "after-evidence", "after-derived", "after-watermark", "after-commit"];
    const alignments = ["empty", "exact", "before", "after"];
    let cases = 0;
    for (const alignment of alignments) {
      const control = mkdtempSync(join(tmpdir(), `backfill-control-${alignment}-`)); roots.push(control);
      const controlChild = launch(control, alignment, "none"); await waitFor(controlChild, "COMPLETED"); await waitExit(controlChild);
      const expected = await canonical(control);
      const controlStore = openSqliteStorage(join(control, "store.db"));
      const expectedCount = await controlStore.get("SELECT count(*) AS n FROM raw_file"); await controlStore.close();
      for (const point of points) {
        const home = mkdtempSync(join(tmpdir(), `backfill-kill-${alignment}-`)); roots.push(home);
        const child = launch(home, alignment, point); await waitFor(child, `BOUNDARY ${point}`);
        expect(child.pid).toBeTypeOf("number"); process.kill(-child.pid!, "SIGKILL"); await waitExit(child); await waitGroupExit(child.pid!);
        const killed = openSqliteStorage(join(home, "store.db")); await runMigrations(killed, MIGRATIONS);
        const killedRaw = await killed.get("SELECT count(*) AS n FROM raw_file");
        const killedWatermark = await killed.get("SELECT watermark FROM source_watermark WHERE source='intervals-icu' AND lane='bulk-fit'");
        const committed = killedWatermark === undefined ? 0
          : Number((JSON.parse(String(killedWatermark.watermark)) as { last_key: string }).last_key);
        expect(committed).toBeLessThanOrEqual(Number(killedRaw!.n));
        expect(Number(killedRaw!.n) - committed).toBeLessThanOrEqual(4);
        await killed.close();
        const resumed = launch(home, alignment, "none"); await waitFor(resumed, "COMPLETED"); await waitExit(resumed);
        expect(await canonical(home)).toBe(expected);
        const store = openSqliteStorage(join(home, "store.db"));
        expect(await store.get("SELECT count(*) AS n FROM raw_file")).toEqual(expectedCount);
        expect(await store.get("SELECT count(*)-count(DISTINCT sha256) AS n FROM raw_file")).toEqual({ n: 0 }); await store.close();
        cases += 1;
      }
    }
    expect(cases).toBe(20);
  });
});
