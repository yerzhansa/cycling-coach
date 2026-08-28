import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ManagedWorkoutReaderError,
  createManagedWorkoutReader,
  type ManagedWorkoutReaderLimits,
  type WorkoutSourceFormat,
} from "../src/workout-import/index.js";

const limits: ManagedWorkoutReaderLimits = {
  workoutBytes: 5_242_880,
  parserMs: 30_000,
  parserOldGenerationMiB: 256,
  candidates: 50,
  segmentsPerWorkout: 5_000,
  durationSeconds: 86_400,
  diagnostics: 100,
  diagnosticChars: 240,
  titleChars: 200,
  purposeChars: 500,
};

const files: Readonly<Record<WorkoutSourceFormat, string>> = {
  zwo: `<workout_file><name>Easy</name><sportType>bike</sportType><workout><SteadyState Duration="600" Power="0.6" /></workout></workout_file>`,
  mrc: `[COURSE HEADER]\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n0 50\n10 50\n[END COURSE DATA]`,
  erg: `[COURSE HEADER]\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0 100\n10 100\n[END COURSE DATA]`,
};

function source(extension: WorkoutSourceFormat, bytes: Uint8Array) {
  return {
    objectId: `object-${extension}`,
    relativePath: `safe/${extension}`,
    displayName: `workout.${extension}`,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    extension,
  } as const;
}

describe("managed planned Workout reader", () => {
  it.each(["zwo", "mrc", "erg"] as const)("parses %s in the packaged worker", async (extension) => {
    const bytes = new TextEncoder().encode(files[extension]);
    const reader = createManagedWorkoutReader({
      objects: { readObjectBytes: async () => bytes },
      limits,
      workerUrl: new URL("../dist/workout-import/worker.js", import.meta.url),
    });
    await expect(reader.read(source(extension, bytes))).resolves.toMatchObject({
      sourceFormat: extension,
      selectedWorkoutId: null,
    });
  });

  it("ships a built worker next to the reader entry", async () => {
    const packageRoot = resolve(import.meta.dirname, "..");
    await expect(
      stat(resolve(packageRoot, "dist/workout-import/worker.js")),
    ).resolves.toMatchObject({
      size: expect.any(Number),
    });
  });

  it("rejects managed-object integrity failures before starting the worker", async () => {
    const bytes = new TextEncoder().encode(files.zwo);
    const reader = createManagedWorkoutReader({
      objects: {
        readObjectBytes: async () => {
          throw new Error("digest mismatch");
        },
      },
      limits,
    });
    await expect(reader.read(source("zwo", bytes))).rejects.toEqual(
      expect.objectContaining<Partial<ManagedWorkoutReaderError>>({ reason: "integrity_mismatch" }),
    );
  });

  it("contains a stalled worker at the parser timeout", async () => {
    const bytes = new TextEncoder().encode(files.zwo);
    const workerUrl = new URL("./fixtures/stalled-workout-worker.js", import.meta.url);
    const reader = createManagedWorkoutReader({
      objects: { readObjectBytes: async () => bytes },
      limits: { ...limits, parserMs: 20 },
      workerUrl,
    });
    await expect(reader.read(source("zwo", bytes))).rejects.toEqual(
      expect.objectContaining<Partial<ManagedWorkoutReaderError>>({ reason: "parser_timeout" }),
    );
  });

  it("rejects a structurally valid worker result with forged stable identities", async () => {
    const bytes = new TextEncoder().encode(files.zwo);
    const reader = createManagedWorkoutReader({
      objects: { readObjectBytes: async () => bytes },
      limits,
      workerUrl: new URL("./fixtures/forged-workout-worker.js", import.meta.url),
    });
    await expect(reader.read(source("zwo", bytes))).rejects.toEqual(
      expect.objectContaining<Partial<ManagedWorkoutReaderError>>({ reason: "worker_failed" }),
    );
  });
});
