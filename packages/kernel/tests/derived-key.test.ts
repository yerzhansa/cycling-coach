import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CryptoPort } from "../src/ports/crypto.js";
import { DerivedKeyError, H, encodeUtf8Strict } from "../src/store/derived-key.js";

function crypto(digest?: Uint8Array):CryptoPort{return{async sha256(data){return digest??new Uint8Array(createHash("sha256").update(data).digest());},async randomBytes(){throw new Error("unused")},async pbkdf2(){throw new Error("unused")},async aesGcmEncrypt(){throw new Error("unused")},async aesGcmDecrypt(){throw new Error("unused")}}}

describe("derived keys",()=>{
  it("matches every chained vector",async()=>{
    const c=crypto(),raw="0123456789abcdef".repeat(4);
    const workout=await H(c,"workout",raw); expect(workout).toBe("5016f224d978cf82ac99f3c35812dfb9956958e51d50d9c2b600dc057b9b5404");
    const session=await H(c,"session",workout,0); expect(session).toBe("773c0ea27fed8112a27f2b4f60f7033e6a18dae42ba717c0fd3f89a922ac20cb");
    expect(await H(c,"lap",session,3)).toBe("89c9171ca9556909fbb4182302e396a63d282f0832a1c5eaf416cac97041814f");
    const lap=await H(c,"lap",session,3); expect(await H(c,"swim_length",lap,2)).toBe("3a296f220d950bb4ff6a9dfa97ab5188899d564bf87da5ee07cc57265eb7d5c8");
    expect(await H(c,"stream",session,"heart_rate")).toBe("f80c186930ab43acb807754dc240bed666d87ad6425a41efe06690dd776969ef");
  });
  it("frames fields, encodes strict UTF-8, and normalizes minus zero",async()=>{
    let framed:Uint8Array|undefined;
    const observing={...crypto(),async sha256(data:Uint8Array){framed=data;return new Uint8Array(32)}};
    await H(observing,"a","b");expect([...framed!]).toEqual([97,31,98]);
    expect([...encodeUtf8Strict("A😀")]).toEqual([65,240,159,152,128]);
    expect(await H(crypto(),-0)).toBe(await H(crypto(),0));
  });
  it("preserves digest leading zeroes and rejects invalid fields",async()=>{
    expect(await H(crypto(new Uint8Array(32)),"x")).toBe("0".repeat(64));
    await expect(H(crypto(),...( [] as unknown as [string]))).rejects.toBeInstanceOf(DerivedKeyError);
    for(const value of [NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,null,undefined] as unknown[]){
      await expect(H(crypto(),value as string)).rejects.toBeInstanceOf(DerivedKeyError);
    }
    expect(()=>encodeUtf8Strict("\ud800")).toThrow(DerivedKeyError);
  });
});
