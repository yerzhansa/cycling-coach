import type { AnchorHistoryRow, AnchorRepository, SqlStore } from "./ports.js";

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
      return r === undefined ? undefined : (r as unknown as AnchorHistoryRow);
    },
  };
}
