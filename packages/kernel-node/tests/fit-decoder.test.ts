import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import FitParser from "fit-file-parser";
import { describe, expect, it, vi } from "vitest";
import { createFitDecoder, FIT_PARSER_OPTIONS } from "../src/ingest/fit-decoder.js";

const fixture=(name:string)=>new Uint8Array(readFileSync(resolve("packages/kernel-node/tests/fixtures/ingest",name)));
function containsUndefined(value:unknown):boolean{if(value===undefined)return true;if(Array.isArray(value))return value.some(containsUndefined);if(value!==null&&typeof value==="object")return Object.values(value).some(containsUndefined);return false;}
async function decodeRoot(root:unknown){const spy=vi.spyOn(FitParser.prototype,"parseAsync").mockResolvedValueOnce(root as never);try{return await createFitDecoder().decode(new Uint8Array())}finally{spy.mockRestore()}}

describe("patched FIT decoder",()=>{
  it("uses the literal parser options and adapts real fixtures without undefined",async()=>{
    expect(FIT_PARSER_OPTIONS).toEqual({force:false,mode:"list"});expect(Object.isFrozen(FIT_PARSER_OPTIONS)).toBe(true);
    const decoded=await createFitDecoder().decode(fixture("triathlon-multisport.fit"));
    expect(containsUndefined(decoded)).toBe(false);expect(decoded.sessions).toHaveLength(5);expect(decoded.records).toHaveLength(14);
    expect(decoded.sessions.map((s)=>[s.sport,s.subSport,s.trigger])).toEqual([["swimming","open_water","auto_multi_sport"],["transition","generic","auto_multi_sport"],["cycling","generic","auto_multi_sport"],["transition","generic","auto_multi_sport"],["running","generic","activity_end"]]);
    expect(decoded.sessions.slice(1).map((s)=>s.startTime)).toEqual(decoded.sessions.slice(0,-1).map((s)=>s.timestamp));
    expect(decoded.records.map((r)=>r.timestamp).filter((t)=>decoded.sessions.slice(1).some((s)=>s.startTime===t))).toEqual(decoded.sessions.slice(1).map((s)=>s.startTime));
    expect(decoded.events.filter((e)=>e.eventType==="marker").map((e)=>[e.event,e.data,e.timestamp])).toEqual([[38,271,decoded.records[2].timestamp],[38,0,(decoded.records.at(-1)?.timestamp as number)-1]]);
    expect(decoded.activity).toMatchObject({timestamp:decoded.sessions.at(-1)?.timestamp,numSessions:5,type:"auto_multi_sport",event:"activity",eventType:"stop"});
  });
  it("preserves all developer occurrences and characterized values",async()=>{
    const decoded=await createFitDecoder().decode(fixture("dual-developer-index.fit"));
    const fields=[...decoded.sessions.flatMap((x)=>x.developerFields),...decoded.laps.flatMap((x)=>x.developerFields),...decoded.records.flatMap((x)=>x.developerFields)];
    expect(fields).toHaveLength(178);expect(new Set(fields.filter((x)=>x.field_name==="currHemoPerc").map((x)=>x.value))).toEqual(new Set([62.099998474121094,65.5999984741211]));
  });
  it("normalizes optional developer metadata and preserves duplicate occurrences",async()=>{
    const envelope={nativeMessageType:20,developer_data_index:1,field_definition_number:2,value:{a:1}};
    const decoded=await decodeRoot({records:[{developer_fields:[envelope,{...envelope,value:{a:1}},{...envelope,value:{a:2}}]}]});
    expect(decoded.records[0].developerFields).toEqual([{...envelope,field_name:null,units:null},{...envelope,field_name:null,units:null},{...envelope,value:{a:2},field_name:null,units:null}]);
    await expect(decodeRoot({records:[{developer_fields:[{...envelope,value:undefined}]}]})).rejects.toMatchObject({code:"decode_failed"});
  });
  it("extracts only the exact left-right mask object and distinguishes enhanced absence",async()=>{
    const decoded=await decodeRoot({records:[{left_right_balance:{value:64,right:true},altitude:10,speed:4}]});
    expect(decoded.records[0]).toMatchObject({leftRightBalance:64,enhancedAltitude:null,altitude:10,enhancedSpeed:null,speed:4});
    for(const bad of [64,{value:64},{value:64,right:1},{value:-1,right:false},{value:128,right:false},{value:1.5,right:false},{value:64,right:false,extra:0}]) {
      await expect(decodeRoot({records:[{left_right_balance:bad}]})).rejects.toMatchObject({code:"invalid_numeric"});
    }
    for(const key of ["enhanced_altitude","enhanced_speed"]) {
      await expect(decodeRoot({records:[{[key]:null}]})).rejects.toMatchObject({code:"invalid_numeric"});
      await expect(decodeRoot({records:[{[key]:"1"}]})).rejects.toMatchObject({code:"invalid_numeric"});
    }
  });
  it("rejects header and file CRC corruption through ordinary awaited calls",async()=>{
    const header=fixture("triathlon-multisport.fit");header[12]^=1;
    await expect(createFitDecoder().decode(header)).rejects.toMatchObject({code:"decode_failed"});
    const file=fixture("triathlon-multisport.fit");file[file.length-1]^=1;
    await expect(createFitDecoder().decode(file)).rejects.toMatchObject({code:"decode_failed"});
  });
});
