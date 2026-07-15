import { compareUtf8 } from "./derived-key.js";
import type { SqlStore } from "./ports.js";

export interface WorkoutRow { readonly workout_key: string; readonly start_utc: number; readonly tz_offset_s: number | null; readonly name: string | null; readonly notes: string | null; readonly is_multisport: number; readonly dedup_cluster_id: string; }
export interface SessionRow { readonly session_key: string; readonly workout_key: string; readonly session_seq: number; readonly sport: string; readonly sub_sport: string | null; readonly start_utc: number; readonly tz_offset_s: number | null; readonly local_date_key: number; readonly elapsed_s: number | null; readonly timer_s: number | null; readonly moving_s: number | null; readonly distance_m: number | null; readonly is_transition: number; readonly summary_json: string | null; }
export interface LapRow { readonly lap_key: string; readonly session_key: string; readonly lap_seq: number; readonly start_utc: number | null; readonly elapsed_s: number | null; readonly timer_s: number | null; readonly distance_m: number | null; readonly summary_json: string | null; }
export interface SwimLengthRow { readonly length_key: string; readonly lap_key: string; readonly length_seq: number; readonly start_utc: number | null; readonly elapsed_s: number | null; readonly timer_s: number | null; readonly strokes: number | null; readonly stroke_type: string | null; readonly length_type: string | null; }
export interface StreamRow { readonly stream_key: string; readonly session_key: string; readonly channel: string; readonly encoding: "f64:raw:zdeflate:le"; readonly sample_rate: null; readonly n: number; readonly data: Uint8Array; }
export interface ActivityRows { readonly workout: WorkoutRow; readonly sessions: readonly SessionRow[]; readonly laps: readonly LapRow[]; readonly swimLengths: readonly SwimLengthRow[]; readonly streams: readonly StreamRow[]; }
export interface ActivityRepository { replaceForRawFile(rawSha256: string, rows: ActivityRows): Promise<void>; }

export function createActivityRepository(store: SqlStore): ActivityRepository {
  return {
    async replaceForRawFile(rawSha256, rows) {
      await store.run(
        `DELETE FROM metric_snapshot
WHERE (
  scope_kind = 'session'
  AND scope_id IN (
    SELECT s.session_key FROM session AS s JOIN workout AS w ON w.workout_key = s.workout_key
    WHERE w.dedup_cluster_id = ?
  )
) OR (
  scope_kind = 'date'
  AND scope_id IN (
    SELECT CAST(s.local_date_key AS TEXT) FROM session AS s JOIN workout AS w ON w.workout_key = s.workout_key
    WHERE w.dedup_cluster_id = ?
  )
)`,
        [rawSha256, rawSha256],
      );
      await store.run("DELETE FROM workout WHERE dedup_cluster_id = ?", [rawSha256]);
      const w = rows.workout;
      await store.run("INSERT INTO workout (workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES (?,?,?,?,?,?,?)", [w.workout_key,w.start_utc,w.tz_offset_s,w.name,w.notes,w.is_multisport,w.dedup_cluster_id]);
      for (const s of [...rows.sessions].sort((a,b) => a.session_seq - b.session_seq)) {
        await store.run("INSERT INTO session (session_key,workout_key,session_seq,sport,sub_sport,start_utc,tz_offset_s,local_date_key,elapsed_s,timer_s,moving_s,distance_m,is_transition,summary_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [s.session_key,s.workout_key,s.session_seq,s.sport,s.sub_sport,s.start_utc,s.tz_offset_s,s.local_date_key,s.elapsed_s,s.timer_s,s.moving_s,s.distance_m,s.is_transition,s.summary_json]);
      }
      for (const l of [...rows.laps].sort((a,b) => compareUtf8(a.session_key,b.session_key) || a.lap_seq-b.lap_seq)) {
        await store.run("INSERT INTO lap (lap_key,session_key,lap_seq,start_utc,elapsed_s,timer_s,distance_m,summary_json) VALUES (?,?,?,?,?,?,?,?)", [l.lap_key,l.session_key,l.lap_seq,l.start_utc,l.elapsed_s,l.timer_s,l.distance_m,l.summary_json]);
      }
      for (const l of [...rows.swimLengths].sort((a,b) => compareUtf8(a.lap_key,b.lap_key) || a.length_seq-b.length_seq)) {
        await store.run("INSERT INTO swim_length (length_key,lap_key,length_seq,start_utc,elapsed_s,timer_s,strokes,stroke_type,length_type) VALUES (?,?,?,?,?,?,?,?,?)", [l.length_key,l.lap_key,l.length_seq,l.start_utc,l.elapsed_s,l.timer_s,l.strokes,l.stroke_type,l.length_type]);
      }
      for (const s of [...rows.streams].sort((a,b) => compareUtf8(a.session_key,b.session_key) || compareUtf8(a.channel,b.channel))) {
        await store.run("INSERT INTO stream (stream_key,session_key,channel,encoding,sample_rate,n,data) VALUES (?,?,?,?,?,?,?)", [s.stream_key,s.session_key,s.channel,s.encoding,s.sample_rate,s.n,s.data]);
      }
    },
  };
}
