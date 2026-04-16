import { describe, it, expect } from "vitest";
import {
  serializeIntervalsWorkout,
  intervalsWorkoutInputSchema,
  InvalidWorkoutError,
  type IntervalsWorkoutInput,
} from "../src/cycling/intervals-serializer.js";

describe("serializeIntervalsWorkout — description output", () => {
  it("emits a Z2 endurance workout as percent-ftp range", () => {
    const input: IntervalsWorkoutInput = {
      name: "Z2 Endurance 90min",
      steps: [
        {
          type: "warmup",
          duration: { value: 10, unit: "minutes" },
          power: { kind: "percent_ftp", low: 50, high: 65 },
          cadence: { low: 85, high: 95 },
        },
        {
          type: "steady",
          duration: { value: 70, unit: "minutes" },
          power: { kind: "percent_ftp", low: 56, high: 75 },
          cadence: { low: 85, high: 95 },
        },
        {
          type: "cooldown",
          duration: { value: 10, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
          cadence: { low: 85, high: 95 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);

    expect(description).toContain("Warmup");
    expect(description).toContain("- 10m 50-65% 85-95rpm");
    expect(description).toContain("Main set");
    expect(description).toContain("- 70m 56-75% 85-95rpm");
    expect(description).toContain("Cooldown");
    expect(description).toContain("- 10m 50% 85-95rpm");
  });

  it("emits a sweet-spot set with Nx line and interval+recovery lines", () => {
    const input: IntervalsWorkoutInput = {
      name: "Sweet Spot 3x15",
      steps: [
        {
          type: "warmup",
          duration: { value: 15, unit: "minutes" },
          power: { kind: "percent_ftp", low: 50, high: 65 },
        },
        {
          type: "set",
          repeat: 3,
          interval: {
            type: "interval",
            duration: { value: 15, unit: "minutes" },
            power: { kind: "percent_ftp", low: 88, high: 94 },
            cadence: { low: 85, high: 95 },
            label: "Sweet spot",
          },
          recovery: {
            type: "recovery",
            duration: { value: 4, unit: "minutes" },
            power: { kind: "percent_ftp", value: 50 },
          },
        },
        {
          type: "cooldown",
          duration: { value: 10, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);

    expect(description).toMatch(/^Warmup$/m);
    expect(description).toContain("- 15m 50-65%");
    expect(description).toContain("Main set");
    expect(description).toMatch(/^3x$/m);
    expect(description).toContain("- 15m 88-94% 85-95rpm Sweet spot");
    expect(description).toContain("- 4m 50%");
    expect(description).toContain("Cooldown");
    expect(description).toContain("- 10m 50%");
  });

  it("emits a ramp step with the 'ramp' keyword and bounds", () => {
    const input: IntervalsWorkoutInput = {
      name: "Ramp warmup",
      steps: [
        {
          type: "ramp",
          duration: { value: 10, unit: "minutes" },
          power: { kind: "percent_ftp", low: 50, high: 80 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    expect(description).toContain("- 10m ramp 50-80%");
  });

  it("emits zone shorthand when kind is zone", () => {
    const input: IntervalsWorkoutInput = {
      name: "Zone targeted",
      steps: [
        {
          type: "steady",
          duration: { value: 60, unit: "minutes" },
          power: { kind: "zone", value: 2 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    expect(description).toContain("- 60m Z2");
  });

  it("emits watts target with absolute values", () => {
    const input: IntervalsWorkoutInput = {
      name: "Watts target",
      steps: [
        {
          type: "steady",
          duration: { value: 30, unit: "minutes" },
          power: { kind: "watts", low: 150, high: 180 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    expect(description).toContain("- 30m 150-180w");
  });

  it("formats sub-minute durations as seconds", () => {
    const input: IntervalsWorkoutInput = {
      name: "Short sprints",
      steps: [
        {
          type: "interval",
          duration: { value: 30, unit: "seconds" },
          power: { kind: "percent_ftp", value: 150 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    expect(description).toContain("- 30s 150%");
  });

  it("formats 90-second durations as 1m30", () => {
    const input: IntervalsWorkoutInput = {
      name: "90s effort",
      steps: [
        {
          type: "interval",
          duration: { value: 90, unit: "seconds" },
          power: { kind: "percent_ftp", value: 120 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    expect(description).toContain("- 1m30 120%");
  });

  it("emits duration-only line for freeride with no power", () => {
    const input: IntervalsWorkoutInput = {
      name: "Outdoor easy",
      steps: [
        {
          type: "freeride",
          duration: { value: 60, unit: "minutes" },
          label: "Keep it easy",
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    expect(description).toContain("- 60m Keep it easy");
  });

  it("does not repeat the section label for consecutive same-section steps", () => {
    const input: IntervalsWorkoutInput = {
      name: "Two warmup steps",
      steps: [
        {
          type: "warmup",
          duration: { value: 5, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
        {
          type: "warmup",
          duration: { value: 5, unit: "minutes" },
          power: { kind: "percent_ftp", value: 60 },
        },
      ],
    };

    const { description } = serializeIntervalsWorkout(input);
    const warmupCount = (description.match(/^Warmup$/gm) ?? []).length;
    expect(warmupCount).toBe(1);
  });
});

describe("serializeIntervalsWorkout — movingTime", () => {
  it("sums simple step durations", () => {
    const input: IntervalsWorkoutInput = {
      name: "Test",
      steps: [
        { type: "warmup", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", value: 55 } },
        { type: "steady", duration: { value: 30, unit: "minutes" }, power: { kind: "percent_ftp", value: 65 } },
        { type: "cooldown", duration: { value: 5, unit: "minutes" }, power: { kind: "percent_ftp", value: 50 } },
      ],
    };

    const { movingTime } = serializeIntervalsWorkout(input);
    expect(movingTime).toBe(45 * 60);
  });

  it("multiplies set durations by repeat count", () => {
    const input: IntervalsWorkoutInput = {
      name: "Test",
      steps: [
        { type: "warmup", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", value: 55 } },
        {
          type: "set",
          repeat: 3,
          interval: { type: "interval", duration: { value: 15, unit: "minutes" }, power: { kind: "percent_ftp", value: 90 } },
          recovery: { type: "recovery", duration: { value: 4, unit: "minutes" }, power: { kind: "percent_ftp", value: 50 } },
        },
        { type: "cooldown", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", value: 50 } },
      ],
    };

    // 10 + (15+4)*3 + 10 = 77 min
    const { movingTime } = serializeIntervalsWorkout(input);
    expect(movingTime).toBe(77 * 60);
  });

  it("handles mixed seconds/minutes", () => {
    const input: IntervalsWorkoutInput = {
      name: "Test",
      steps: [
        { type: "steady", duration: { value: 90, unit: "seconds" }, power: { kind: "percent_ftp", value: 70 } },
        { type: "steady", duration: { value: 2, unit: "minutes" }, power: { kind: "percent_ftp", value: 70 } },
      ],
    };

    const { movingTime } = serializeIntervalsWorkout(input);
    expect(movingTime).toBe(90 + 120);
  });
});

describe("serializeIntervalsWorkout — trainingLoad", () => {
  it("computes load ≈ 40 for a pure Z2 60min ride", () => {
    const input: IntervalsWorkoutInput = {
      name: "Z2 60min",
      steps: [
        {
          type: "steady",
          duration: { value: 60, unit: "minutes" },
          power: { kind: "percent_ftp", value: 65 },
        },
      ],
    };

    const { trainingLoad } = serializeIntervalsWorkout(input);
    // 60min at 65% FTP: intensity=0.65, load = 3600 * 0.65^2 / 3600 * 100 = 42.25 → 42
    expect(trainingLoad).toBe(42);
  });

  it("returns undefined when any step uses watts and ftpWatts is missing", () => {
    const input: IntervalsWorkoutInput = {
      name: "Watts workout",
      steps: [
        {
          type: "steady",
          duration: { value: 60, unit: "minutes" },
          power: { kind: "watts", value: 200 },
        },
      ],
    };

    const { trainingLoad } = serializeIntervalsWorkout(input);
    expect(trainingLoad).toBeUndefined();
  });

  it("computes load from watts when ftpWatts is provided", () => {
    const input: IntervalsWorkoutInput = {
      name: "Watts workout",
      steps: [
        {
          type: "steady",
          duration: { value: 60, unit: "minutes" },
          power: { kind: "watts", value: 200 },
        },
      ],
    };

    const { trainingLoad } = serializeIntervalsWorkout(input, 200);
    // intensity = 200/200 = 1.0, load = 100
    expect(trainingLoad).toBe(100);
  });

  it("returns undefined when no step has a power target", () => {
    const input: IntervalsWorkoutInput = {
      name: "Freeride",
      steps: [
        {
          type: "freeride",
          duration: { value: 60, unit: "minutes" },
        },
      ],
    };

    const { trainingLoad } = serializeIntervalsWorkout(input);
    expect(trainingLoad).toBeUndefined();
  });
});

describe("serializeIntervalsWorkout — validation", () => {
  it("rejects empty steps array at schema level", () => {
    const bad = { name: "Empty", steps: [] };
    expect(() => serializeIntervalsWorkout(bad as IntervalsWorkoutInput)).toThrow();
  });

  it("rejects ramp without power.low and power.high", () => {
    const input = {
      name: "Bad ramp",
      steps: [
        {
          type: "ramp" as const,
          duration: { value: 10, unit: "minutes" as const },
          power: { kind: "percent_ftp" as const, value: 70 },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
    expect(() => serializeIntervalsWorkout(input)).toThrow(/ramp requires power\.low and power\.high/);
  });

  it("rejects ramp with no power target at all", () => {
    const input = {
      name: "Bad ramp",
      steps: [
        {
          type: "ramp" as const,
          duration: { value: 10, unit: "minutes" as const },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects zone values outside 1-7", () => {
    const input = {
      name: "Bad zone",
      steps: [
        {
          type: "steady" as const,
          duration: { value: 30, unit: "minutes" as const },
          power: { kind: "zone" as const, value: 8 },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
    expect(() => serializeIntervalsWorkout(input)).toThrow(/zone must be an integer/);
  });

  it("rejects percent_ftp above sanity bound", () => {
    const input = {
      name: "Absurd percent",
      steps: [
        {
          type: "interval" as const,
          duration: { value: 30, unit: "seconds" as const },
          power: { kind: "percent_ftp" as const, value: 250 },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
    expect(() => serializeIntervalsWorkout(input)).toThrow(/exceeds sanity bound/);
  });

  it("rejects watts above sanity bound", () => {
    const input = {
      name: "Absurd watts",
      steps: [
        {
          type: "interval" as const,
          duration: { value: 5, unit: "seconds" as const },
          power: { kind: "watts" as const, value: 2000 },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects power with no value and no range", () => {
    const input = {
      name: "Empty power",
      steps: [
        {
          type: "steady" as const,
          duration: { value: 30, unit: "minutes" as const },
          power: { kind: "percent_ftp" as const },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects power.low greater than power.high", () => {
    const input = {
      name: "Inverted range",
      steps: [
        {
          type: "steady" as const,
          duration: { value: 30, unit: "minutes" as const },
          power: { kind: "percent_ftp" as const, low: 90, high: 70 },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects cadence.low greater than cadence.high", () => {
    const input = {
      name: "Inverted cadence",
      steps: [
        {
          type: "steady" as const,
          duration: { value: 30, unit: "minutes" as const },
          power: { kind: "percent_ftp" as const, value: 65 },
          cadence: { low: 100, high: 80 },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects set with repeat > 20 at schema level", () => {
    const input = {
      name: "Too many repeats",
      steps: [
        {
          type: "set" as const,
          repeat: 21,
          interval: {
            type: "interval" as const,
            duration: { value: 1, unit: "minutes" as const },
            power: { kind: "percent_ftp" as const, value: 110 },
          },
          recovery: {
            type: "recovery" as const,
            duration: { value: 1, unit: "minutes" as const },
            power: { kind: "percent_ftp" as const, value: 50 },
          },
        },
      ],
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow();
  });

  it("rejects top-level steps array longer than 40", () => {
    const step = {
      type: "steady" as const,
      duration: { value: 1, unit: "minutes" as const },
      power: { kind: "percent_ftp" as const, value: 65 },
    };
    const input = {
      name: "Too many steps",
      steps: Array.from({ length: 41 }, () => step),
    };

    expect(() => serializeIntervalsWorkout(input)).toThrow();
  });
});

describe("intervalsWorkoutInputSchema", () => {
  it("rejects distance-based durations (schema enum)", () => {
    const result = intervalsWorkoutInputSchema.safeParse({
      name: "Distance",
      steps: [
        {
          type: "steady",
          duration: { value: 10, unit: "distance_km" },
          power: { kind: "percent_ftp", value: 70 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = intervalsWorkoutInputSchema.safeParse({
      steps: [
        {
          type: "steady",
          duration: { value: 10, unit: "minutes" },
          power: { kind: "percent_ftp", value: 70 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
