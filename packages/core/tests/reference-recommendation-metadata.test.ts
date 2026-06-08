import { describe, it, expect } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  CitationSchema,
  RecommendationMetadataSchema,
  AuditLogEntrySchema,
  type RecommendationMetadata,
} from "../src/reference/validation/recommendation-metadata.js";

const validMetadata: RecommendationMetadata = {
  citations: [
    { field: "current_status.acwr.value", value: 1.12, source: "latest.json" },
  ],
  confidence: "high",
  frameworks: ["polarized"],
  phase_tag: "build",
};

describe("RecommendationMetadataSchema", () => {
  it("accepts a fully-valid object and round-trips it", () => {
    const parsed = RecommendationMetadataSchema.parse(validMetadata);
    expect(parsed).toEqual(validMetadata);
  });

  it("rejects an empty frameworks array (min(1) violation)", () => {
    expect(() =>
      RecommendationMetadataSchema.parse({ ...validMetadata, frameworks: [] }),
    ).toThrow();
  });

  it("rejects a confidence outside {high,medium,low}", () => {
    expect(() =>
      RecommendationMetadataSchema.parse({
        ...validMetadata,
        confidence: "very-high",
      }),
    ).toThrow();
  });

  it("rejects an unknown top-level field (.strict() boundary)", () => {
    expect(() =>
      RecommendationMetadataSchema.parse({ ...validMetadata, extra: "x" }),
    ).toThrow();
  });
});

describe("CitationSchema", () => {
  it("rejects a source other than 'latest.json' (z.literal violation)", () => {
    expect(() =>
      CitationSchema.parse({
        field: "current_status.acwr.value",
        value: 1.12,
        source: "history.json",
      }),
    ).toThrow();
  });

  it("rejects an unknown field (.strict() boundary)", () => {
    expect(() =>
      CitationSchema.parse({
        field: "x",
        value: 1,
        source: "latest.json",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("AuditLogEntrySchema", () => {
  it("exposes AUDIT_SCHEMA_VERSION === '1'", () => {
    expect(AUDIT_SCHEMA_VERSION).toBe("1");
  });

  it("accepts a valid entry and round-trips it", () => {
    const entry = {
      schema_version: AUDIT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      chatId: "12345",
      responseHash: "abcdef0123456789",
      metadata: validMetadata,
    };
    const parsed = AuditLogEntrySchema.parse(entry);
    expect(parsed).toEqual(entry);
  });

  it("accepts the optional validation_warning field and round-trips it", () => {
    const entry = {
      schema_version: AUDIT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      chatId: "12345",
      responseHash: "abcdef0123456789",
      metadata: validMetadata,
      validation_warning: true,
    };
    const parsed = AuditLogEntrySchema.parse(entry);
    expect(parsed.validation_warning).toBe(true);
  });

  it("rejects an unknown top-level field (.strict() boundary)", () => {
    expect(() =>
      AuditLogEntrySchema.parse({
        schema_version: AUDIT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        chatId: "12345",
        responseHash: "abcdef0123456789",
        metadata: validMetadata,
        future_field_typo: "nope",
      }),
    ).toThrow();
  });
});
