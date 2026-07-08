export function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSerialize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = stableSerialize(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableSerialize(value), null, 2);
}
