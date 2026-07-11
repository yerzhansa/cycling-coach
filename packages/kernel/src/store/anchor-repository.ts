import type { AnchorHistoryRow, AnchorRepository, Row, SqlStore } from "./ports.js";

function toAnchorHistoryRow(r: Row): AnchorHistoryRow {
  return {
    id: r.id as string,
    sport: r.sport as string,
    anchor_type: r.anchor_type as string,
    value: r.value as number,
    unit: r.unit as string,
    valid_from: r.valid_from as number,
    source: r.source as string,
    confidence: r.confidence as string,
    note: r.note as string | null,
    provenance: r.provenance as string,
    device_id: r.device_id as string | null,
    hlc_physical_ms: r.hlc_physical_ms as number | null,
    hlc_counter: r.hlc_counter as number | null,
  };
}

export function createAnchorRepository(store: SqlStore): AnchorRepository {
  return {
    async insertIfAbsent(row: AnchorHistoryRow): Promise<boolean> {
      const existing = await store.get(
        "SELECT 1 AS x FROM anchor_history WHERE sport = ? AND anchor_type = ? AND valid_from = ?",
        [row.sport, row.anchor_type, row.valid_from],
      );
      if (existing) return false;
      await store.run(
        "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          row.id,
          row.sport,
          row.anchor_type,
          row.value,
          row.unit,
          row.valid_from,
          row.source,
          row.confidence,
          row.note,
          row.provenance,
          row.device_id,
          row.hlc_physical_ms,
          row.hlc_counter,
        ],
      );
      return true;
    },
    async readCurrent(
      sport: string,
      anchorType: string,
      asOfEpochS: number,
    ): Promise<AnchorHistoryRow | undefined> {
      const r = await store.get(
        "SELECT * FROM anchor_history WHERE sport = ? AND anchor_type = ? AND valid_from <= ? ORDER BY valid_from DESC, CASE confidence WHEN 'manual' THEN 0 WHEN 'platform' THEN 1 WHEN 'fit' THEN 2 ELSE 3 END ASC LIMIT 1",
        [sport, anchorType, asOfEpochS],
      );
      return r === undefined ? undefined : toAnchorHistoryRow(r);
    },
  };
}
