import { createActivityRepository, type ActivityRows } from "../store/activity-repository.js";
import { DERIVED_TABLES } from "../store/dump.js";
import { compareUtf8 } from "../store/derived-key.js";
import { createRepairLogRepository } from "../store/repair-log-repository.js";
import type { MigratorStore } from "../store/migrator.js";
import type { SqlStore } from "../store/ports.js";
import { createRawFileRepository } from "../store/source-repository.js";
import type { CryptoPort } from "../ports/crypto.js";
import { compareUnicodeCodePoints } from "./repair/types.js";
import { rescalePoolDistances } from "./pool-size-rescale.js";
import type { MappedFitArtifact } from "./types.js";

function cloneStructuredValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("structured repair params must not be cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneStructuredValue(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("structured repair params must be plain objects");
    }
    const output = Object.create(prototype) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("structured repair params must not contain symbols");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new TypeError("structured repair params must contain enumerable data properties");
      }
      Object.defineProperty(output, key, {
        value: cloneStructuredValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function cloneMappedFitArtifactForRebuild(artifact: MappedFitArtifact): MappedFitArtifact {
  const activity: ActivityRows = {
    workout: { ...artifact.activity.workout },
    sessions: artifact.activity.sessions.map((session) => ({ ...session })),
    laps: artifact.activity.laps.map((lap) => ({ ...lap })),
    swimLengths: artifact.activity.swimLengths.map((length) => ({ ...length })),
    streams: artifact.activity.streams.map((stream) => ({ ...stream, data: new Uint8Array(stream.data) })),
    repairLogs: artifact.activity.repairLogs.map((fact) => ({
      ...fact,
      changedIndices: [...fact.changedIndices],
      params: cloneStructuredValue(fact.params) as Readonly<Record<string, unknown>>,
    })),
    poolSessions: artifact.activity.poolSessions.map((pool) => ({
      ...pool,
      lengths: pool.lengths.map((length) => ({ ...length })),
    })),
  };
  return {
    rawFile: { ...artifact.rawFile },
    activity,
    logicalArchiveEpochSeconds: artifact.logicalArchiveEpochSeconds,
  };
}

export async function rebuildRawFileInTransaction(store: SqlStore, artifact: MappedFitArtifact, crypto: CryptoPort): Promise<{ rawInserted: boolean }> {
  const rebuildArtifact = cloneMappedFitArtifactForRebuild(artifact);
  const rawInserted = await createRawFileRepository(store).upsert(rebuildArtifact.rawFile);
  const correctedSessions=new Map<string,{sessionDistanceM:number|null;lengths:ReadonlyMap<string,number|null>}>();
  for(const pool of rebuildArtifact.activity.poolSessions){
    const overlay=await store.get(`SELECT corrected_pool_length_m
FROM pool_size_correction_overlay
WHERE target_session_key = ?
ORDER BY hlc_physical_ms DESC, hlc_counter DESC, device_id DESC, id DESC
LIMIT 1`,[pool.sessionKey]);
    const correction=overlay===undefined?null:overlay.corrected_pool_length_m;
    if(correction!==null&&typeof correction!=="number") throw new TypeError("invalid pool correction");
    const scaled=rescalePoolDistances({sourceSessionDistanceM:pool.sourceSessionDistanceM,lengths:pool.lengths,correctedPoolLengthM:correction});
    correctedSessions.set(pool.sessionKey,{sessionDistanceM:scaled.sessionDistanceM,lengths:new Map(scaled.lengths.map((length)=>[length.lengthKey,length.distanceM]))});
  }
  const lapToSession=new Map(rebuildArtifact.activity.laps.map((lap)=>[lap.lap_key,lap.session_key]));
  const activity={
    ...rebuildArtifact.activity,
    sessions:rebuildArtifact.activity.sessions.map((session)=>{
      const corrected=correctedSessions.get(session.session_key);
      return corrected===undefined?{...session}:{...session,distance_m:corrected.sessionDistanceM};
    }),
    swimLengths:rebuildArtifact.activity.swimLengths.map((length)=>{
      const sessionKey=lapToSession.get(length.lap_key);
      const corrected=sessionKey===undefined?undefined:correctedSessions.get(sessionKey);
      return {...length,distance_m:corrected?.lengths.get(length.length_key)??length.distance_m};
    }),
  };
  const repairRepository=createRepairLogRepository(store,crypto);
  const fixerOrder={chronoBridge:0,summitGuard:1,pulseWeave:2} as const;
  await createActivityRepository(store).replaceForRawFile(rebuildArtifact.rawFile.sha256, activity, async()=>{
    const facts=[...activity.repairLogs].sort((left,right)=>compareUtf8(left.sessionKey,right.sessionKey)||fixerOrder[left.fixer]-fixerOrder[right.fixer]||compareUnicodeCodePoints(left.channel,right.channel));
    for(const fact of facts) await repairRepository.insertOrAssertIdentical({rawSha256:rebuildArtifact.rawFile.sha256,sessionKey:fact.sessionKey,channel:fact.channel,fixer:fact.fixer,changedIndices:fact.changedIndices,params:fact.params});
  });
  return { rawInserted };
}

export async function rebuildRawFile(store: SqlStore & Pick<MigratorStore, "transaction">, artifact: MappedFitArtifact, crypto: CryptoPort): Promise<{ rawInserted: boolean }> {
  return store.transaction(() => rebuildRawFileInTransaction(store, artifact, crypto));
}

export async function deleteAllDerivedRowsInTransaction(store: SqlStore): Promise<void> {
  for (const table of DERIVED_TABLES) await store.exec(`DELETE FROM ${table}`);
}
