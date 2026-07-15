import { access } from "node:fs/promises";
import { expect, it } from "vitest";

it("imports the built SQLite public entry", async () => {
  const entry = new URL("../dist/sqlite.js", import.meta.url);
  await access(entry);

  const publicApi = await import(entry.href);

  expect(publicApi.openSqliteStorage).toBeTypeOf("function");
});
