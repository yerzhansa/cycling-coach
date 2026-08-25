import { parentPort } from "node:worker_threads";

parentPort?.postMessage({
  ok: true,
  result: {
    schemaVersion: 1,
    setId: "forged-set",
    sourceFormat: "zwo",
    parserVersion: "cycling-workout-v1",
    selectedWorkoutId: null,
    workouts: [
      {
        workoutId: "forged-workout",
        title: "Forged",
        sport: "cycling",
        durationSeconds: 60,
        purpose: null,
        segments: [
          {
            segmentId: "forged-segment",
            kind: "steady",
            seconds: 60,
            power: { kind: "ftp_fraction_range", low: 0.5, high: 0.5 },
          },
        ],
      },
    ],
    diagnostics: [],
  },
});
