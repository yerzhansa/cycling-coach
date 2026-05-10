// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { describe, expect, it } from "vitest";
import { formatSnapshotRaw } from "../src/reference/sync/snapshot-debug.js";
import type { LatestJson } from "../src/reference/schemas/latest.js";

const tinyLatest: LatestJson = {
  metadata: {
    schema_version: "1",
    last_updated: "2026-05-09T14:00:00Z",
    freshness: "fresh",
  },
  athlete_profile: { id: "test", name: "Athlete" },
  current_status: { fitness: 70 },
  derived_metrics: {},
  recent_activities: [{ id: 1 }],
  planned_workouts: [],
  wellness_data: { sleep_hours: 7.5 },
};

describe("formatSnapshotRaw", () => {
  it("returns 'Reference hasn't synced yet' guidance when latest is null", () => {
    const out = formatSnapshotRaw(null);
    expect(out.kind).toBe("chunks");
    if (out.kind === "chunks") {
      expect(out.chunks).toHaveLength(1);
      expect(out.chunks[0]).toContain("Reference hasn't synced yet");
      expect(out.chunks[0]).toContain("/sync");
    }
  });

  it("returns chunked markdown for a small full dump (each chunk ≤4096 chars)", () => {
    const out = formatSnapshotRaw(tinyLatest);
    expect(out.kind).toBe("chunks");
    if (out.kind === "chunks") {
      expect(out.chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of out.chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
        expect(chunk.startsWith("```json")).toBe(true);
        expect(chunk.endsWith("```")).toBe(true);
      }
      // The serialized data should appear somewhere in the chunks.
      expect(out.chunks.join("")).toContain("\"id\": \"test\"");
      expect(out.chunks.join("")).toContain("\"sleep_hours\": 7.5");
    }
  });

  it("returns just the requested section when a valid name is passed", () => {
    const out = formatSnapshotRaw(tinyLatest, "wellness_data");
    expect(out.kind).toBe("chunks");
    if (out.kind === "chunks") {
      expect(out.chunks.join("")).toContain("\"sleep_hours\": 7.5");
      expect(out.chunks.join("")).not.toContain("\"athlete_profile\"");
    }
  });

  it("accepts section names case-insensitively", () => {
    const out = formatSnapshotRaw(tinyLatest, "Wellness_Data");
    expect(out.kind).toBe("chunks");
    if (out.kind === "chunks") {
      expect(out.chunks.join("")).toContain("\"sleep_hours\": 7.5");
    }
  });

  it("returns a help-style message listing valid sections when an unknown section is requested", () => {
    const out = formatSnapshotRaw(tinyLatest, "garbage_section");
    expect(out.kind).toBe("chunks");
    if (out.kind === "chunks") {
      expect(out.chunks).toHaveLength(1);
      expect(out.chunks[0]).toContain("Unknown section");
      expect(out.chunks[0]).toContain("athlete_profile");
      expect(out.chunks[0]).toContain("wellness_data");
    }
  });

  it("returns a document buffer when total bytes exceed the document threshold", () => {
    // Build a recent_activities array large enough to exceed 64 KiB.
    const fatActivities = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `Activity ${i}`,
      description: "x".repeat(500),
    }));
    const fat: LatestJson = {
      ...tinyLatest,
      recent_activities: fatActivities,
    };

    const out = formatSnapshotRaw(fat);
    expect(out.kind).toBe("document");
    if (out.kind === "document") {
      expect(out.buffer.byteLength).toBeGreaterThan(65_536);
      expect(out.filename).toMatch(/^snapshot-.*\.json$/);
      const parsed = JSON.parse(out.buffer.toString("utf8"));
      expect(parsed.recent_activities).toHaveLength(200);
    }
  });

  it("returns a document buffer when chunk count would exceed the chunk threshold", () => {
    // Build a body whose JSON is between byte and chunk thresholds. Trick: many
    // moderately-sized records that JSON-stringify to >10 chunks but <64 KiB.
    // 10 chunks × ~4080 chars body ≈ 40 KB — well under the byte limit.
    const padded: LatestJson = {
      ...tinyLatest,
      derived_metrics: { padding: "y".repeat(45_000) },
    };

    const out = formatSnapshotRaw(padded);
    expect(out.kind).toBe("document");
    if (out.kind === "document") {
      expect(out.filename).toMatch(/^snapshot-.*\.json$/);
    }
  });

  it("forces document mode when athlete data contains a Markdown fence-breaker (```)", () => {
    // An athlete's activity description containing a code block would close
    // the outer ```json fence early under Markdown parse mode. Document mode
    // side-steps the escaping entirely.
    const fenceBreaking: LatestJson = {
      ...tinyLatest,
      recent_activities: [
        {
          id: 1,
          name: "Easy ride",
          description: "Notes from coach:\n```\npush 220W on the climb\n```\nfelt good",
        },
      ],
    };

    const out = formatSnapshotRaw(fenceBreaking);
    expect(out.kind).toBe("document");
    if (out.kind === "document") {
      expect(out.filename).toMatch(/^snapshot-.*\.json$/);
      // The serialized body still contains the offending substring — the fix
      // is about routing, not sanitizing.
      expect(out.buffer.toString("utf8")).toContain("```");
    }
  });

  it("forces document mode when a single section contains a fence-breaker", () => {
    // Sectioned snapshot must apply the same protection.
    const fenceBreaking: LatestJson = {
      ...tinyLatest,
      athlete_profile: { id: "test", bio: "weekend warrior ```cyclist```" },
    };

    const out = formatSnapshotRaw(fenceBreaking, "athlete_profile");
    expect(out.kind).toBe("document");
  });
});
