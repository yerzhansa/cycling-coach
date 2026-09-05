import { validateSelection } from "./structure.js";

export type CoverageEntry =
  | { readonly id: string; readonly kind: "ready" }
  | { readonly id: string; readonly kind: "pending"; readonly dependency: string };

export type VerifiedCoverage = {
  readonly readyIds: readonly string[];
  readonly selectedIds: readonly string[];
  readonly pending: readonly { readonly id: string; readonly dependency: string }[];
};

export function verifyStoryCoverage(
  index: unknown,
  coverage: readonly CoverageEntry[],
  selectedIds?: readonly string[],
): VerifiedCoverage {
  const allIds = coverage.map((entry) => entry.id);
  validateSelection(allIds, allIds);
  const readyIds: string[] = [];
  const pending: { id: string; dependency: string }[] = [];
  for (const entry of coverage) {
    if (entry.id === "coverage--pending")
      throw new TypeError("Coverage/Pending is reserved for the coverage report");
    if (entry.kind === "pending") {
      if (entry.dependency.trim().length === 0)
        throw new TypeError(`pending scenario lacks a dependency: ${entry.id}`);
      pending.push({ id: entry.id, dependency: entry.dependency });
    } else {
      if ("dependency" in entry)
        throw new TypeError(`ready scenario carries a pending dependency: ${entry.id}`);
      readyIds.push(entry.id);
    }
  }
  const selected = selectedIds ?? readyIds;
  for (const id of selected) {
    if (pending.some((entry) => entry.id === id))
      throw new TypeError(`pending scenario cannot be selected as ready: ${id}`);
  }
  validateSelection(readyIds, selected);
  const stories = storyIds(index);
  const indexedPending = pending.filter((entry) => stories.includes(entry.id));
  if (indexedPending.length > 0)
    throw new TypeError(
      `pending scenarios have executable stories: ${indexedPending.map((entry) => entry.id).join(", ")}`,
    );
  const missing = readyIds.filter((id) => !stories.includes(id));
  const unregistered = stories.filter((id) => !readyIds.includes(id));
  if (missing.length > 0 || unregistered.length > 0) {
    throw new TypeError(
      `story coverage mismatch; missing: ${missing.join(", ") || "none"}; unregistered: ${unregistered.join(", ") || "none"}`,
    );
  }
  return { readyIds, selectedIds: selected, pending };
}

function storyIds(index: unknown): readonly string[] {
  if (!isRecord(index) || index.v !== 5 || !isRecord(index.entries))
    throw new TypeError("expected a Storybook v5 index with entries");
  const ids: string[] = [];
  for (const [key, entry] of Object.entries(index.entries)) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0 ||
      entry.id !== key
    ) {
      throw new TypeError(`invalid Storybook entry identity: ${key}`);
    }
    if (entry.type !== "story" && entry.type !== "docs")
      throw new TypeError(`unknown Storybook entry type: ${key}`);
    if (entry.id === "coverage--pending") {
      if (entry.type !== "story" || entry.title !== "Coverage" || entry.name !== "Pending") {
        throw new TypeError("only the Coverage/Pending report may use coverage--pending");
      }
      continue;
    }
    if (entry.type === "story") ids.push(entry.id);
  }
  validateSelection(ids, ids);
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
