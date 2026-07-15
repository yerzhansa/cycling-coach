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
  it("keeps one raw row and produces byte-identical non-vacuous dumps",async()=>{
    expect(DERIVED_TABLES.join(",")).toBe("metric_snapshot,mean_max_cache,repair_log,stream,swim_length,lap,session,workout");
    dir=mkdtempSync(join(tmpdir(),"fit-inv2-"));const archiveRoot=join(dir,"archive");await mkdir(dirname(join(archiveRoot,"x")),{recursive:true});
    const store=openSqliteStorage(join(dir,"store.db"));try{
      await runMigrations(store,MIGRATIONS);const archive=createArchiveManager({archiveRoot,crypto,fs:fsPort});const bytes=new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit")));const deps={archive,crypto,store,decoder:createFitDecoder()};
      const first=await importFitArtifact(bytes,deps);expect(first).toMatchObject({kind:"imported",rawInserted:true});const dump1=await dumpStore(store);
      const second=await importFitArtifact(bytes,deps);expect(second).toMatchObject({kind:"imported",rawInserted:false});const dump2=await dumpStore(store);
      expect(dump2).toBe(dump1);expect((await store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(1);expect((await store.get("SELECT count(*) c FROM source_record"))?.c).toBe(0);
      expect((await store.get("SELECT count(*) c FROM workout"))?.c).toBe(1);expect(Number((await store.get("SELECT count(*) c FROM session"))?.c)).toBeGreaterThan(0);expect(Number((await store.get("SELECT count(*) c FROM lap"))?.c)).toBeGreaterThan(0);expect(Number((await store.get("SELECT count(*) c FROM stream"))?.c)).toBeGreaterThan(0);
    }finally{await store.close()}
  });
});
