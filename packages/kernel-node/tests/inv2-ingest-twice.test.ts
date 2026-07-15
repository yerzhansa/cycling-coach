import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import { DERIVED_TABLES, dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createArchiveManager } from "../src/archive/index.js";
import { createFitDecoder } from "../src/ingest/fit-decoder.js";
import { importFitArtifact } from "../src/ingest/fit-import.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const crypto:CryptoPort={async sha256(d){return new Uint8Array(createHash("sha256").update(d).digest())},async randomBytes(n){return new Uint8Array(randomBytes(n))},async pbkdf2(){throw new Error("unused")},async aesGcmEncrypt(){throw new Error("unused")},async aesGcmDecrypt(){throw new Error("unused")}};
const fsPort:FileSystemPort={async readFile(p){return new Uint8Array(await readFile(p))},async readTextFile(p){return readFile(p,"utf8")},async writeFile(p,data,o){const temp=`${p}.tmp.${randomBytes(4).toString("hex")}`;const h=await open(temp,"w",o?.mode??0o600);try{await h.writeFile(typeof data==="string"?Buffer.from(data):Buffer.from(data));await h.sync()}finally{await h.close()}await rename(temp,p)},async rename(a,b){await rename(a,b)},async mkdir(p,o){await mkdir(p,{recursive:o?.recursive??false})},async list(){throw new Error("unused")},async stat(p){try{const s=await stat(p);return{kind:s.isFile()?"file":s.isDirectory()?"directory":"other",size:s.size,mtimeMs:s.mtimeMs}}catch{return undefined}}};
let dir:string|undefined;afterEach(()=>{if(dir)rmSync(dir,{recursive:true,force:true});dir=undefined});

describe("INV-2 ingest twice",()=>{
  it("keeps stream BLOB bytes and repair_log rows identical with zero new raw rows",async()=>{
    expect(DERIVED_TABLES.join(",")).toBe("metric_snapshot,mean_max_cache,repair_log,stream,swim_length,lap,session,workout");
    dir=mkdtempSync(join(tmpdir(),"fit-inv2-"));const archiveRoot=join(dir,"archive");await mkdir(dirname(join(archiveRoot,"x")),{recursive:true});
    const store=openSqliteStorage(join(dir,"store.db"));try{
      await runMigrations(store,MIGRATIONS);const archive=createArchiveManager({archiveRoot,crypto,fs:fsPort});const bytes=new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit")));const deps={archive,crypto,store,decoder:createFitDecoder(),reconstructArchivedArtifact:async()=>null};
      const first=await importFitArtifact(bytes,deps);expect(first).toMatchObject({kind:"imported",rawInserted:true});const dump1=await dumpStore(store);
      const streams1=await store.all("SELECT stream_key,session_key,channel,encoding,sample_rate,n,data FROM stream ORDER BY stream_key");
      const logs1=await store.all("SELECT repair_key,raw_sha256,session_key,channel,fixer,changed_count,changed_indices_json,params_json FROM repair_log ORDER BY repair_key");
      const second=await importFitArtifact(bytes,deps);expect(second).toMatchObject({kind:"imported",rawInserted:false});const dump2=await dumpStore(store);
      expect(await store.all("SELECT stream_key,session_key,channel,encoding,sample_rate,n,data FROM stream ORDER BY stream_key")).toEqual(streams1);
      expect(await store.all("SELECT repair_key,raw_sha256,session_key,channel,fixer,changed_count,changed_indices_json,params_json FROM repair_log ORDER BY repair_key")).toEqual(logs1);
      expect(logs1.length).toBeGreaterThan(0);expect(logs1.every((row)=>row.raw_sha256===first.rawSha256)).toBe(true);
      expect(streams1.every((row)=>row.encoding==="f64:raw:zdeflate:le"&&row.sample_rate===null&&typeof row.n==="number"&&row.n>0&&row.data instanceof Uint8Array)).toBe(true);
      const bySession=new Map<string,Set<number>>();for(const row of streams1){const set=bySession.get(row.session_key as string)??new Set<number>();set.add(row.n as number);bySession.set(row.session_key as string,set)}expect([...bySession.values()].every((set)=>set.size===1)).toBe(true);
      for(const sessionKey of bySession.keys()){
        const channels=streams1.filter((row)=>row.session_key===sessionKey).map((row)=>row.channel as string);
        const expected=1+(channels.length-1)+Number(channels.includes("power"))+Number(channels.includes("speed"))+Number(channels.includes("heart_rate"));
        expect(logs1.filter((row)=>row.session_key===sessionKey)).toHaveLength(expected);
      }
      expect(logs1.some((row)=>row.fixer==="chronoBridge"&&row.channel==="time"&&Number(row.changed_count)>0)).toBe(true);
      expect(await store.get("SELECT singleton,ingest_version FROM ingest_metadata")).toEqual({singleton:1,ingest_version:1});
      expect(dump2).toBe(dump1);expect((await store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(1);expect((await store.get("SELECT count(*) c FROM source_record"))?.c).toBe(0);
      expect((await store.get("SELECT count(*) c FROM workout"))?.c).toBe(1);expect(Number((await store.get("SELECT count(*) c FROM session"))?.c)).toBeGreaterThan(0);expect(Number((await store.get("SELECT count(*) c FROM lap"))?.c)).toBeGreaterThan(0);expect(Number((await store.get("SELECT count(*) c FROM stream"))?.c)).toBeGreaterThan(0);
    }finally{await store.close()}
  });
});
