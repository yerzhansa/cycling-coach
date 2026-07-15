import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { DecodedFitFile } from "@enduragent/kernel/ingest";
import type { CryptoPort } from "@enduragent/kernel/ports";
import { RawFileInvariantError, runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createFitDecoder } from "../src/ingest/fit-decoder.js";
import { importFitArtifact, importFitBatch } from "../src/ingest/fit-import.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const crypto:CryptoPort={async sha256(d){return new Uint8Array(createHash("sha256").update(d).digest())},async randomBytes(){throw new Error("unused")},async pbkdf2(){throw new Error("unused")},async aesGcmEncrypt(){throw new Error("unused")},async aesGcmDecrypt(){throw new Error("unused")}};
const bytes=new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit")));
const address=(value:Uint8Array=bytes)=>createHash("sha256").update(value).digest("hex");
function archive(events:string[],fail=false,instants:number[]=[],addresses:string[]=[]):ArchiveManager{return{async writeArtifact(input,ext,when){events.push("archive");instants.push(when.epochSeconds);if(fail)throw new Error("archive failed");const digest=address(input);addresses.push(digest);return{address:digest,relPath:`1998/07/${digest}.${ext}`,deduped:false}},async quarantine(input,ext,reason){events.push(`quarantine:${reason}`);const digest=address(input);return{address:digest,relPath:`quarantine/${digest}.${ext}`,deduped:false}},async writeSnapshot(){throw new Error("unused")},async readArtifact(){throw new Error("unused")},async readSnapshot(){throw new Error("unused")},async has(){return false}}}
const decoder=(decoded:DecodedFitFile)=>({async decode(){return decoded}});
const guarded=<T extends object>(value:T)=>({...value,reconstructArchivedArtifact:async()=>null});

describe("archive-first FIT import",()=>{
  let store:SqlStore&MigratorStore;
  beforeEach(async()=>{store=openSqliteStorage(":memory:");await runMigrations(store,MIGRATIONS)});afterEach(async()=>store.close());
  it("quarantines decode failures with zero SQL",async()=>{
    const events:string[]=[];const result=await importFitArtifact(new Uint8Array([1]),guarded({archive:archive(events),crypto,store,decoder:createFitDecoder()}));
    expect(result).toMatchObject({kind:"quarantined",reason:"fit:decode_failed"});expect(events).toEqual(["quarantine:fit:decode_failed"]);expect((await store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(0);
  });
  it("archives before transaction and writes no source ledger row",async()=>{
    const events:string[]=[];const original=store.transaction.bind(store);store.transaction=async(fn)=>{events.push("transaction");return original(fn)};
    const result=await importFitArtifact(bytes,guarded({archive:archive(events),crypto,store,decoder:createFitDecoder()}));
    expect(result).toMatchObject({kind:"imported",rawInserted:true});expect(events).toEqual(["transaction","archive","transaction"]);expect((await store.get("SELECT count(*) c FROM source_record"))?.c).toBe(0);
  });
  it("does not start SQL when archive fails",async()=>{
    const events:string[]=[];let transactions=0;const original=store.transaction.bind(store);store.transaction=async(fn)=>{transactions++;return original(fn)};
    await store.run("UPDATE ingest_metadata SET ingest_version=1");
    await expect(importFitArtifact(bytes,guarded({archive:archive(events,true),crypto,store,decoder:createFitDecoder()}))).rejects.toThrow("archive failed");expect(transactions).toBe(0);
  });
  it("leaves archive-only state when SQL fails",async()=>{
    const events:string[]=[];const original=store.transaction.bind(store);store.transaction=async(fn)=>original(async()=>{events.push("transaction");await fn();expect(Number((await store.get("SELECT count(*) c FROM raw_file"))?.c)).toBe(1);throw new Error("sql failed")});
    await store.run("UPDATE ingest_metadata SET ingest_version=1");
    await expect(importFitArtifact(bytes,guarded({archive:archive(events),crypto,store,decoder:createFitDecoder()}))).rejects.toThrow("sql failed");expect(events).toEqual(["archive","transaction"]);expect((await store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(0);
  });
  it("reimports exactly and rejects same-SHA metadata drift",async()=>{
    const events:string[]=[];const decoded=await createFitDecoder().decode(bytes);const deps=guarded({archive:archive(events),crypto,store,decoder:decoder(decoded)});
    await expect(importFitArtifact(bytes,deps)).resolves.toMatchObject({kind:"imported",rawInserted:true});
    await expect(importFitArtifact(bytes,deps)).resolves.toMatchObject({kind:"imported",rawInserted:false});
    const changed={...decoded,fileIds:[{...decoded.fileIds[0],productName:"different"},...decoded.fileIds.slice(1)]};
    await expect(importFitArtifact(bytes,{...deps,decoder:decoder(changed)})).rejects.toMatchObject({name:"RawFileInvariantError",mismatchedColumns:["product"]} satisfies Partial<RawFileInvariantError>);
    expect((await store.get("SELECT product FROM raw_file WHERE sha256=?",[address()]))?.product).not.toBe("different");
  });
  it("uses file creation time before session start for archive placement",async()=>{
    const events:string[]=[];const instants:number[]=[];const decoded=await createFitDecoder().decode(bytes);const created=decoded.sessions[0].startTime!+12345;
    const changed={...decoded,fileIds:[{...decoded.fileIds[0],timeCreated:created},...decoded.fileIds.slice(1)]};
    await importFitArtifact(bytes,guarded({archive:archive(events,false,instants),crypto,store,decoder:decoder(changed)}));
    expect(instants).toEqual([created]);
  });
  it("runs the version guard exactly once before a guarded single import archives",async()=>{
    await store.run("UPDATE ingest_metadata SET ingest_version=1");
    const events:string[]=[];let checks=0;const originalAll=store.all.bind(store);store.all=async(sql,params)=>{if(sql.includes("SELECT ingest_version")){checks++;events.push("ensure")}return originalAll(sql,params)};
    const a=archive(events);await importFitArtifact(bytes,guarded({archive:a,crypto,store,decoder:createFitDecoder()}));
    expect(checks).toBe(1);expect(events.indexOf("ensure")).toBeLessThan(events.indexOf("archive"));
  });
  it("runs one guard before a three-item batch and uses the internal body three times",async()=>{
    await store.run("UPDATE ingest_metadata SET ingest_version=1");
    const events:string[]=[];let checks=0;const originalAll=store.all.bind(store);store.all=async(sql,params)=>{if(sql.includes("SELECT ingest_version")){checks++;events.push("ensure")}return originalAll(sql,params)};
    const payloads={c:new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit"))),a:new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest/brick-cycling.fit"))),b:new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest/pool-size-correction.fit")))};
    const items=[{inputPath:"c",bytes:payloads.c},{inputPath:"a",bytes:payloads.a},{inputPath:"b",bytes:payloads.b}];
    const before=items.map((item)=>({inputPath:item.inputPath,bytes:new Uint8Array(item.bytes)}));const decodedAddresses:string[]=[];const decodedInputs:Uint8Array[]=[];const archivedAddresses:string[]=[];const realDecoder=createFitDecoder();
    await importFitBatch(items,{archive:archive(events,false,[],archivedAddresses),crypto,store,decoder:{async decode(input:Uint8Array){decodedInputs.push(input);decodedAddresses.push(address(input));return realDecoder.decode(input)}},reconstructArchivedArtifact:async()=>null});
    const expected=[address(payloads.a),address(payloads.b),address(payloads.c)];
    expect(checks).toBe(1);expect(events.filter((event)=>event==="archive")).toHaveLength(3);expect(events[0]).toBe("ensure");expect(decodedAddresses).toEqual(expected);expect(archivedAddresses).toEqual(expected);expect(decodedInputs[0]).not.toBe(payloads.a);expect(decodedInputs[1]).not.toBe(payloads.b);expect(decodedInputs[2]).not.toBe(payloads.c);expect(items).toEqual(before);expect(items.map((item)=>item.bytes)).toEqual([payloads.c,payloads.a,payloads.b]);
  });
  it("makes ensure failure perform zero archive, quarantine, or transaction calls",async()=>{
    await store.run("UPDATE ingest_metadata SET ingest_version=2");
    const events:string[]=[];let transactions=0;const original=store.transaction.bind(store);store.transaction=async(fn)=>{transactions++;return original(fn)};
    await expect(importFitArtifact(bytes,guarded({archive:archive(events),crypto,store,decoder:createFitDecoder()}))).rejects.toThrow("newer ingest semantics");
    expect(events).toEqual([]);expect(transactions).toBe(0);
  });
});
