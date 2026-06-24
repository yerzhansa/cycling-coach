export const STREAM_BIN_SECONDS = 10;
export const STREAM_RESULT_TARGET_TOKENS = 7_000;

type ChannelSummary = {
  min: number;
  max: number;
  mean: number;
  samples: number[];
};

export type DownsampledStreams = {
  binSeconds: number;
  sampleCount: number;
  bins: number;
  channels: Record<string, ChannelSummary>;
};

function isNumericArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

function summarizeChannel(values: number[], binSeconds: number): ChannelSummary {
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = Math.round((sum / values.length) * 10) / 10;

  const samples: number[] = [];
  for (let i = 0; i < values.length; i += binSeconds) {
    let binSum = 0;
    let binCount = 0;
    for (let j = i; j < i + binSeconds && j < values.length; j++) {
      binSum += values[j];
      binCount++;
    }
    samples.push(Math.round(binSum / binCount));
  }

  return { min, max, mean, samples };
}

export function downsampleStreams(
  raw: Record<string, unknown>,
  opts?: { binSeconds?: number },
): DownsampledStreams {
  const binSeconds = opts?.binSeconds ?? STREAM_BIN_SECONDS;
  const channels: Record<string, ChannelSummary> = {};
  let sampleCount = 0;
  let bins = 0;

  for (const [name, value] of Object.entries(raw)) {
    if (!isNumericArray(value) || value.length === 0) continue;
    const summary = summarizeChannel(value, binSeconds);
    channels[name] = summary;
    if (value.length > sampleCount) sampleCount = value.length;
    if (summary.samples.length > bins) bins = summary.samples.length;
  }

  return { binSeconds, sampleCount, bins, channels };
}
