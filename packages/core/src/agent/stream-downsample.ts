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

// intervals.icu's streams endpoint returns an array of channel objects
// (`[{type, data}, …]`); only some integrations pre-key it into `{watts, …}`.
// Accept both so the live array form is not silently dropped, and tolerate the
// null gaps the API marks with `allNull` — a dropped sensor packet must not lose
// the whole channel.
function toChannelArrays(raw: unknown): Array<[string, unknown[]]> {
  if (Array.isArray(raw)) {
    const out: Array<[string, unknown[]]> = [];
    for (const el of raw) {
      if (el === null || typeof el !== "object") continue;
      const { type, data } = el as { type?: unknown; data?: unknown };
      if (typeof type === "string" && Array.isArray(data)) out.push([type, data]);
    }
    return out;
  }
  if (raw !== null && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, unknown[]] => Array.isArray(entry[1]),
    );
  }
  return [];
}

function summarizeChannel(values: readonly unknown[], binSeconds: number): ChannelSummary | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  const samples: number[] = [];

  for (let i = 0; i < values.length; i += binSeconds) {
    let binSum = 0;
    let binCount = 0;
    for (let j = i; j < i + binSeconds && j < values.length; j++) {
      const v = values[j];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      binSum += v;
      binCount++;
    }
    if (binCount === 0) continue;
    sum += binSum;
    count += binCount;
    samples.push(Math.round(binSum / binCount));
  }

  if (count === 0) return null;
  const mean = Math.round((sum / count) * 10) / 10;
  return { min, max, mean, samples };
}

export function downsampleStreams(
  raw: Record<string, unknown> | unknown[],
  opts?: { binSeconds?: number },
): DownsampledStreams {
  const binSeconds = opts?.binSeconds ?? STREAM_BIN_SECONDS;
  const channels: Record<string, ChannelSummary> = {};
  let sampleCount = 0;
  let bins = 0;

  for (const [name, values] of toChannelArrays(raw)) {
    const summary = summarizeChannel(values, binSeconds);
    if (!summary) continue;
    channels[name] = summary;
    if (values.length > sampleCount) sampleCount = values.length;
    if (summary.samples.length > bins) bins = summary.samples.length;
  }

  return { binSeconds, sampleCount, bins, channels };
}
