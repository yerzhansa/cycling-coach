import { unzlibSync, zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { decodeStream, encodeStream, STREAM_ENCODING, StreamCodecError } from "../src/ingest/stream-codec.js";

const hex=(x:Uint8Array)=>[...x].map((b)=>b.toString(16).padStart(2,"0")).join("");
const compressed=(raw:Uint8Array)=>zlibSync(raw,{level:6});
const raw=(values:readonly(number|null)[]=[1])=>unzlibSync(encodeStream("value",values).data);
const changed=(values:readonly(number|null)[],change:(payload:Uint8Array)=>Uint8Array|void)=>{const payload=raw(values);return compressed(change(payload)??payload)};
const u32=(payload:Uint8Array,offset:number,value:number)=>new DataView(payload.buffer,payload.byteOffset,payload.byteLength).setUint32(offset,value,true);
const f64=(payload:Uint8Array,offset:number,value:number)=>new DataView(payload.buffer,payload.byteOffset,payload.byteLength).setFloat64(offset,value,true);
function rejects(run:()=>unknown,want:string){try{run();throw new Error("accepted")}catch(error){expect(error).toBeInstanceOf(StreamCodecError);expect((error as StreamCodecError).code).toBe(want)}}

describe("STRM v1 codec",()=>{
  it("matches the exact raw and compressed n=3 golden and round trips both kinds",()=>{
    const encoded=encodeStream("value",[1,null,-2.5]);
    expect(encoded).toMatchObject({encoding:STREAM_ENCODING,n:3});
    expect(hex(unzlibSync(encoded.data))).toBe("5354524d01010000030000000100000005000000000000f03f000000000000000000000000000004c0");
    expect(hex(encoded.data)).toBe("789c0b0e09f2656464606066606000520cac400c041fec21340cb01c0000499d0345");
    expect(decodeStream({...encoded,kind:"value"})).toEqual([1,null,-2.5]);
    const time=encodeStream("time",[1,2.5,4]);expect(decodeStream({...time,kind:"time"})).toEqual([1,2.5,4]);
    expect(encodeStream("value",[1,null,-2.5]).data).toEqual(encodeStream("value",[1,null,-2.5]).data);
  });
  it("uses LSB-first n=10 bitmaps and normalizes minus zero",()=>{
    const values=Array<number|null>(10).fill(null);values[0]=1;values[7]=2;values[8]=-0;
    const payload=raw(values);expect([payload[16],payload[17]]).toEqual([0x81,0x01]);
    expect(Object.is(decodeStream({...encodeStream("value",values),kind:"value"})[8],-0)).toBe(false);
  });
  it("applies every direct-encode error in contract order",()=>{
    rejects(()=>encodeStream("value",[]),"invalid_n");
    rejects(()=>encodeStream("value",[undefined] as unknown as number[]),"present_nonfinite");
    rejects(()=>encodeStream("value",[NaN]),"present_nonfinite");
    rejects(()=>encodeStream("value",[Infinity]),"present_nonfinite");
    rejects(()=>encodeStream("time",[null]),"time_missing");
    rejects(()=>encodeStream("time",[2,2]),"time_nonmonotonic");
    rejects(()=>encodeStream("value",[null]),"all_missing");
  });
  it("returns every stable decode error",()=>{
    const good=encodeStream("value",[1]);
    rejects(()=>decodeStream({...good,encoding:"x",data:new Uint8Array([1]),kind:"value"}),"unsupported_encoding");
    rejects(()=>decodeStream({...good,data:new Uint8Array([1]),kind:"value"}),"inflate_failed");
    rejects(()=>decodeStream({...good,data:compressed(new Uint8Array(15)),kind:"value"}),"payload_length");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[0]=0}),kind:"value"}),"bad_magic");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[4]=2}),kind:"value"}),"bad_version");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[5]=2}),kind:"value"}),"bad_dtype");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[6]=1}),kind:"value"}),"bad_delta");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[7]=1}),kind:"value"}),"bad_endian");
    rejects(()=>decodeStream({...good,n:0,kind:"value"}),"invalid_n");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{u32(p,8,0)}),kind:"value"}),"invalid_n");
    rejects(()=>decodeStream({...good,n:2,kind:"value"}),"n_mismatch");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{u32(p,12,2)}),kind:"value"}),"bitmap_length");
    rejects(()=>decodeStream({...good,data:changed([1],p=>p.slice(0,-1)),kind:"value"}),"payload_length");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{const x=new Uint8Array(p.length+1);x.set(p);return x}),kind:"value"}),"trailing_bytes");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[16]|=2}),kind:"value"}),"high_bitmap_bits");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[16]=0}),kind:"value"}),"missing_slot_nonzero");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{f64(p,17,NaN)}),kind:"value"}),"present_nonfinite");
    const missing=encodeStream("value",[null,2]);rejects(()=>decodeStream({...missing,kind:"time"}),"time_missing");
    const nonmonotonic=encodeStream("value",[2,1]);rejects(()=>decodeStream({...nonmonotonic,kind:"time"}),"time_nonmonotonic");
    rejects(()=>decodeStream({...good,data:changed([1],p=>{p[16]=0;p.fill(0,17)}),kind:"value"}),"all_missing");
  });
  it("keeps compound corruption precedence deterministic",()=>{
    const one=encodeStream("value",[1]);
    const bitmapAndTrailing=changed([1],p=>{u32(p,12,2);const x=new Uint8Array(p.length+1);x.set(p);return x});
    rejects(()=>decodeStream({...one,data:bitmapAndTrailing,kind:"value"}),"bitmap_length");
    const shortAndHigh=changed([1],p=>{p[16]|=2;return p.slice(0,-1)});
    rejects(()=>decodeStream({...one,data:shortAndHigh,kind:"value"}),"payload_length");
    const missingAndNan=changed([1,2],p=>{p[16]&=~1;f64(p,17+8,NaN)});
    rejects(()=>decodeStream({...encodeStream("value",[1,2]),data:missingAndNan,kind:"value"}),"missing_slot_nonzero");
    const missingAndNonmonotonic=changed([1,2,1],p=>{p[16]&=~1;p.fill(0,17,25)});
    rejects(()=>decodeStream({...encodeStream("value",[1,2,1]),data:missingAndNonmonotonic,kind:"time"}),"time_missing");
  });
});
