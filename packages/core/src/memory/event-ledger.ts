import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LEDGER_EVENT_KINDS = [
  "decision",
  "override",
  "illness",
  "experiment",
  "outcome",
] as const;
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

export const LEDGER_EVENT_SOURCES = ["flush"] as const;
export type LedgerEventSource = (typeof LEDGER_EVENT_SOURCES)[number];

export const LEDGER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
export type LedgerEventInput = Omit<LedgerEvent, "ts">;

export const LEDGER_FILENAME = "events.jsonl";

export function appendLedgerEvent(memoryDir: string, event: LedgerEventInput): void {
  const line = ledgerEventSchema.parse({ ts: new Date().toISOString(), ...event });
  appendFileSync(join(memoryDir, LEDGER_FILENAME), JSON.stringify(line) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}
