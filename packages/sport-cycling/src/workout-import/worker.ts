import { parentPort, workerData } from "node:worker_threads";
import { parseWorkoutBytes, WorkoutParseError, type ParseWorkoutInput } from "./parser.js";

function run(input: ParseWorkoutInput): void {
  parentPort?.postMessage({ ok: true, result: parseWorkoutBytes(input) });
}

try {
  run(workerData as ParseWorkoutInput);
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    reason: error instanceof WorkoutParseError ? error.code : "worker_failed",
  });
}
