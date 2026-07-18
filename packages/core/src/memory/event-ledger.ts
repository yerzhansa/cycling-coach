import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  LEDGER_DATE_PATTERN,
  LEDGER_EVENT_KINDS,
  LEDGER_EVENT_SOURCES,
  type LedgerEventInput,
} from "@enduragent/engine/sport";

export {
  LEDGER_DATE_PATTERN,
  LEDGER_EVENT_KINDS,
  LEDGER_EVENT_SOURCES,
};
export type {
  LedgerEventInput,
  LedgerEventKind,
  LedgerEventSource,
} from "@enduragent/engine/sport";

// Append-only invariant: lines are never rewritten or pruned, and the
// parse-before-append below guarantees every committed line satisfies
// ledgerEventSchema — readers may parse without a quarantine path.
export const ledgerEventSchema = z.object({
  ts: z.string(),
  date: z.string().regex(LEDGER_DATE_PATTERN),
  kind: z.enum(LEDGER_EVENT_KINDS),
  text: z.string().min(1),
  source: z.enum(LEDGER_EVENT_SOURCES),
});

export type LedgerEvent = z.infer<typeof ledgerEventSchema>;
export const LEDGER_FILENAME = "events.jsonl";

export function appendLedgerEvent(memoryDir: string, event: LedgerEventInput): void {
  const line = ledgerEventSchema.parse({ ts: new Date().toISOString(), ...event });
  appendFileSync(join(memoryDir, LEDGER_FILENAME), JSON.stringify(line) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}
