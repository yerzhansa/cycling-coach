import { describe, expect, it } from "vitest";

import { AbsoluteImportPathSchema, TrainingExportDestinationPathSchema } from "../src/index.js";

describe.each([
  ["training export", TrainingExportDestinationPathSchema],
  ["training import", AbsoluteImportPathSchema],
])("%s absolute path contract", (_name, schema) => {
  it.each(["/home/x/ride.fit", "C:\\Users\\x\\Documents\\ride.fit", "\\\\server\\share\\ride.fit"])(
    "accepts %s",
    (path) => {
      expect(schema.parse(path)).toBe(path);
    },
  );

  it.each([
    ["empty", ""],
    ["filename", "ride.fit"],
    ["dot-relative", "./x"],
    ["backslash-relative", "x\\y"],
    ["NUL", "/home/x/ride\0.fit"],
    ["over-length", `/${"x".repeat(4_096)}`],
  ])("rejects %s paths", (_case, path) => {
    expect(schema.safeParse(path).success).toBe(false);
  });
});
