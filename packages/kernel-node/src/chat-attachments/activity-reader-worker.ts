import { parentPort, workerData } from "node:worker_threads";
import type { ImportArtifact, RepairFixerSettings } from "@enduragent/kernel/ingest";
import { prepareActivityArtifact } from "../ingest/import-files.js";

interface ActivityWorkerInput {
  readonly inputPath: string;
  readonly extension: "fit" | "tcx" | "gpx";
  readonly bytes: Uint8Array;
  readonly repairSettings: RepairFixerSettings;
}

async function run(input: ActivityWorkerInput): Promise<void> {
  const artifact: ImportArtifact = {
    input_path: input.inputPath,
    bytes: input.bytes,
    ext: input.extension,
  };
  parentPort?.postMessage({
    ok: true,
    result: await prepareActivityArtifact(artifact, input.repairSettings),
  });
}

void run(workerData as ActivityWorkerInput).catch(() => {
  parentPort?.postMessage({ ok: false, reason: "validation_failed" });
});
