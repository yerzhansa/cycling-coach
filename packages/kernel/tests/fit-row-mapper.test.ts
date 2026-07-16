import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CryptoPort } from "../src/ports/crypto.js";
import { FitSourceError, mapFitArtifact, type DecodedActivity, type DecodedFitFile, type DecodedLap, type DecodedLength, type DecodedRecord, type DecodedSession } from "../src/ingest/index.js";
import { decodeStream } from "../src/ingest/stream-codec.js";

const crypto:CryptoPort={async sha256(d){return new Uint8Array(createHash("sha256").update(d).digest())},async randomBytes(){throw new Error("unused")},async pbkdf2(){throw new Error("unused")},async aesGcmEncrypt(){throw new Error("unused")},async aesGcmDecrypt(){throw new Error("unused")}};
const session=(sourceIndex:number,startTime:number,timestamp:number,overrides:Partial<DecodedSession>={}):DecodedSession=>({sourceIndex,sport:"cycling",subSport:"generic",startTime,timestamp,trigger:"activity_end",firstLapIndex:null,numLaps:null,totalElapsedTime:1.5,totalTimerTime:1.499,totalMovingTime:.5,totalDistance:10,developerFields:[],...overrides});
const record=(sourceIndex:number,timestamp:number,overrides:Partial<DecodedRecord>={}):DecodedRecord=>({sourceIndex,timestamp,positionLat:null,positionLong:null,distance:null,enhancedAltitude:null,altitude:null,enhancedSpeed:null,speed:null,heartRate:null,cadence:null,fractionalCadence:null,power:null,temperature:null,stanceTime:null,stanceTimeBalance:null,verticalOscillation:null,verticalRatio:null,stepLength:null,leftRightBalance:null,respirationRate:null,developerFields:[],coordinateUnit:"degrees",...overrides});
const lap=(sourceIndex:number,overrides:Partial<DecodedLap>={}):DecodedLap=>({sourceIndex,startTime:1000,timestamp:1001,firstLengthIndex:null,numLengths:null,numActiveLengths:null,totalElapsedTime:1,totalTimerTime:1,totalDistance:25,developerFields:[],...overrides});
const length=(sourceIndex:number,overrides:Partial<DecodedLength>={}):DecodedLength=>({sourceIndex,startTime:1000,timestamp:1001,totalElapsedTime:1,totalTimerTime:1,totalStrokes:10,swimStroke:"freestyle",lengthType:"active",...overrides});
const decoded=(sessions:DecodedSession[],records:DecodedRecord[],overrides:Partial<DecodedFitFile>={}):DecodedFitFile=>({fileIds:[{serialNumber:1,timeCreated:900,manufacturer:"development",product:1,productName:null}],activity:null,sessions,laps:[],lengths:[],records,events:[],developerDataIds:[],...overrides});
const map=(d:DecodedFitFile)=>mapFitArtifact({crypto,rawSha256:"01".repeat(32),rawByteLength:10,archivePath:null,decoded:d});
const error=async(promise:Promise<unknown>,code:string)=>expect(promise).rejects.toMatchObject({code});

describe("FIT row mapper",()=>{
  it("maps rows, enhanced fields, integer durations, local date, and aligned channels",async()=>{
    const d=decoded([session(0,1000,1002,{developerFields:[{nativeMessageType:18,developer_data_index:0,field_definition_number:1,field_name:"Score %",units:"%",value:{b:2,a:1}}]})],[record(0,1000,{enhancedAltitude:20,altitude:10,heartRate:120,developerFields:[{nativeMessageType:20,developer_data_index:0,field_definition_number:2,field_name:"Metric",units:"u",value:3.5}]}),record(1,1001,{altitude:11,heartRate:null})]);
    const out=await map({...d,developerDataIds:[{developerDataIndex:0,applicationId:Array.from({length:16},(_,i)=>i)}]});expect(out.activity.sessions[0]).toMatchObject({sport:"cycling",elapsed_s:2,timer_s:1,moving_s:1,distance_m:10,local_date_key:19700101});
    expect(out.activity.sessions[0].summary_json).toContain('"normalized_name":"score_%25"');
    const altitude=out.activity.streams.find((s)=>s.channel==="altitude")!;expect(decodeStream({...altitude,kind:"value"})).toEqual([20,11]);
    const heart=out.activity.streams.find((s)=>s.channel==="heart_rate")!;expect(decodeStream({...heart,kind:"value"})).toEqual([120,null]);
    expect(out.activity.streams.some((s)=>s.channel.endsWith(":metric"))).toBe(true);
  });
  it("maps every native record channel and prefers enhanced values",async()=>{
    const values:Partial<DecodedRecord>={positionLat:1,positionLong:2,distance:3,enhancedAltitude:4,altitude:40,enhancedSpeed:5,speed:50,heartRate:6,cadence:7,fractionalCadence:8,power:9,temperature:10,stanceTime:11,stanceTimeBalance:12,verticalOscillation:13,verticalRatio:14,stepLength:15,leftRightBalance:16,respirationRate:17};
    const out=await map(decoded([session(0,0,1)],[record(0,0,values)]));
    const expected={time:0,lat:1,lng:2,distance:3,altitude:4,speed:5,heart_rate:6,cadence:7,fractional_cadence:8,power:9,temperature:10,stance_time:11,stance_time_balance:12,vertical_oscillation:13,vertical_ratio:14,step_length:15,left_right_balance:16,respiration_rate:17};
    expect(out.activity.streams.map((s)=>s.channel).sort()).toEqual(Object.keys(expected).sort());
    for(const row of out.activity.streams) expect(decodeStream({...row,kind:row.channel==="time"?"time":"value"})).toEqual([expected[row.channel as keyof typeof expected]]);
    await error(map(decoded([session(0,0,1)],[record(0,0,{leftRightBalance:-1})])),"invalid_numeric");
    await error(map(decoded([session(0,0,1)],[record(0,0,{leftRightBalance:1.5})])),"invalid_numeric");
    await error(map(decoded([session(0,0,1)],[record(0,0,{leftRightBalance:128})])),"invalid_numeric");
  });
  it("uses the exact duration rounding vectors and rejects invalid values",async()=>{
    for(const [value,want] of [[1.001,1],[1.499,1],[1.5,2],[.499,0],[.5,1]] as const){
      const out=await map(decoded([session(0,0,1,{totalElapsedTime:value,totalTimerTime:value,totalMovingTime:value})],[]));
      expect(out.activity.sessions[0]).toMatchObject({elapsed_s:want,timer_s:want,moving_s:want});
    }
    await error(map(decoded([session(0,0,1,{totalElapsedTime:-.001})],[])),"invalid_numeric");
    await error(map(decoded([session(0,0,1,{totalElapsedTime:Number.MAX_SAFE_INTEGER+1})],[])),"invalid_numeric");
  });
  it("uses half-open shared boundaries by session index",async()=>{
    const sessions=[session(0,0,3,{sport:"swimming",subSport:"open_water",trigger:2}),session(1,3,5,{sport:"transition",trigger:2}),session(2,5,9,{sport:"cycling",trigger:2}),session(3,9,11,{sport:"transition",trigger:2}),session(4,11,14,{sport:"running",trigger:0})];
    const times=[0,1,2,3,4,5,6,7,8,9,10,11,12,14];const out=await map(decoded(sessions,times.map((t,i)=>record(i,t))));
    const timeRows=out.activity.streams.filter((s)=>s.channel==="time").sort((a,b)=>out.activity.sessions.findIndex((x)=>x.session_key===a.session_key)-out.activity.sessions.findIndex((x)=>x.session_key===b.session_key));
    expect(timeRows.map((s)=>s.n)).toEqual([3,2,4,2,4]);expect(out.activity.sessions.filter((s)=>s.is_transition).map((s)=>s.session_seq)).toEqual([1,3]);
  });
  it("uses positive elapsed time for a single-session zero-width source range",async()=>{
    const source=session(0,0,0,{totalElapsedTime:1.1});
    await expect(map(decoded([source],[record(0,0),record(1,1),record(2,2)]))).resolves.toBeDefined();
    await error(map(decoded([source],[record(0,0),record(1,3)])),"record_unassigned");
    await error(map(decoded([source,session(1,2,3)],[record(0,.5),record(1,2)])),"record_unassigned");
    const activity:DecodedActivity={timestamp:null,localTimestamp:null,numSessions:2,type:null,event:null,eventType:null};
    await error(map(decoded([source],[record(0,0),record(1,1)],{activity})),"record_unassigned");
  });
  it("honors source-error precedence and does not sort records",async()=>{
    await expect(map(decoded([], [record(0,NaN)]))).rejects.toMatchObject({code:"missing_session"});
    await expect(map(decoded([session(0,0,3,{sport:null,startTime:NaN})],[]))).rejects.toMatchObject({code:"invalid_date"});
    await expect(map(decoded([session(0,0,3)],[record(0,2),record(1,1)]))).rejects.toMatchObject({code:"record_time_nonmonotonic"});
    await expect(map(decoded([session(0,0,1),session(1,2,3)],[record(0,1.5)]))).rejects.toMatchObject({code:"record_unassigned"});
  });
  it("rejects unequal developer duplicates and accepts equal structured duplicates",async()=>{
    const a={nativeMessageType:18,developer_data_index:0,field_definition_number:1,field_name:"x",units:null,value:{b:2,a:1}};
    await expect(map(decoded([session(0,0,1,{developerFields:[a,{...a,value:{a:1,b:2}}]})],[]))).resolves.toBeDefined();
    await expect(map(decoded([session(0,0,1,{developerFields:[a,{...a,value:2}]})],[]))).rejects.toMatchObject({code:"developer_identity_conflict"} satisfies Partial<FitSourceError>);
  });
  it("normalizes exhaustive enums from numeric and string forms",async()=>{
    const sports={0:"generic",1:"running",2:"cycling",3:"transition",4:"fitness_equipment",5:"swimming",6:"basketball",7:"soccer",8:"tennis",9:"american_football",10:"training",11:"walking",12:"cross_country_skiing",13:"alpine_skiing",14:"snowboarding",15:"rowing",16:"mountaineering",17:"hiking",18:"multisport",19:"paddling",20:"flying",21:"e_biking",22:"motorcycling",23:"boating",24:"driving",25:"golf",26:"hang_gliding",27:"horseback_riding",28:"hunting",29:"fishing",30:"inline_skating",31:"rock_climbing",32:"sailing",33:"ice_skating",34:"sky_diving",35:"snowshoeing",36:"snowmobiling",37:"stand_up_paddleboarding",38:"surfing",39:"wakeboarding",40:"water_skiing",41:"kayaking",42:"rafting",43:"windsurfing",44:"kitesurfing",45:"tactical",46:"jumpmaster",47:"boxing",48:"floor_climbing",53:"diving",254:"all"} as const;
    const subSports={0:"generic",1:"treadmill",2:"street",3:"trail",4:"track",5:"spin",6:"indoor_cycling",7:"road",8:"mountain",9:"downhill",10:"recumbent",11:"cyclocross",12:"hand_cycling",13:"track_cycling",14:"indoor_rowing",15:"elliptical",16:"stair_climbing",17:"lap_swimming",18:"open_water",19:"flexibility_training",20:"strength_training",21:"warm_up",22:"match",23:"exercise",24:"challenge",25:"indoor_skiing",26:"cardio_training",27:"indoor_walking",28:"e_bike_fitness",29:"bmx",30:"casual_walking",31:"speed_walking",32:"bike_to_run_transition",33:"run_to_bike_transition",34:"swim_to_bike_transition",35:"atv",36:"motocross",37:"backcountry",38:"resort",39:"rc_drone",40:"wingsuit",41:"whitewater",42:"skate_skiing",43:"yoga",44:"pilates",45:"indoor_running",46:"gravel_cycling",47:"e_bike_mountain",48:"commuting",49:"mixed_surface",50:"navigate",51:"track_me",52:"map",53:"single_gas_diving",54:"multi_gas_diving",55:"gauge_diving",56:"apnea_diving",57:"apnea_hunting",58:"virtual_activity",59:"obstacle",254:"all"} as const;
    for(const [raw,name] of Object.entries(sports)) for(const input of [Number(raw),name]) expect((await map(decoded([session(0,0,1,{sport:input})],[]))).activity.sessions[0].sport).toBe(name);
    for(const [raw,name] of Object.entries(subSports)) for(const input of [Number(raw),name]) expect((await map(decoded([session(0,0,1,{subSport:input})],[]))).activity.sessions[0].sub_sport).toBe(name);
    for(const [raw,name] of Object.entries({0:"activity_end",1:"manual",2:"auto_multi_sport",3:"fitness_equipment"})) for(const input of [Number(raw),name]) expect(JSON.parse((await map(decoded([session(0,0,1,{trigger:input})],[]))).activity.sessions[0].summary_json!).trigger).toBe(name);
    expect(JSON.parse((await map(decoded([session(0,0,1,{trigger:99})],[]))).activity.sessions[0].summary_json!).trigger).toBe("unknown:99");
    for(const bad of ["",99,1.5,NaN] as const) await error(map(decoded([session(0,0,1,{sport:bad})],[])),"invalid_enum");
  });
  it("maps lap and length scalars, drill values, and ownership truth tables",async()=>{
    const baseSession=session(0,1000,1002,{firstLapIndex:0,numLaps:1});
    const baseLap=lap(0,{firstLengthIndex:0,numLengths:1,numActiveLengths:1,totalElapsedTime:1.5,totalTimerTime:.5});
    const out=await map(decoded([baseSession],[],{laps:[baseLap],lengths:[length(0,{swimStroke:4,lengthType:1,totalElapsedTime:1.499,totalTimerTime:.5})]}));
    expect(out.activity.laps[0]).toMatchObject({lap_seq:0,elapsed_s:2,timer_s:1,distance_m:25});
    expect(out.activity.swimLengths[0]).toMatchObject({length_seq:0,elapsed_s:1,timer_s:1,strokes:10,stroke_type:"drill",length_type:"active"});
    await expect(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:null})],[]))).resolves.toBeDefined();
    await error(map(decoded([session(0,0,1,{firstLapIndex:0,numLaps:null})],[])),"lap_slice_invalid");
    await expect(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:0})],[]))).resolves.toBeDefined();
    await error(map(decoded([session(0,0,1,{firstLapIndex:1,numLaps:0})],[])),"lap_slice_invalid");
    await expect(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:1})],[],{laps:[lap(0)]}))).resolves.toBeDefined();
    await expect(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:null})],[],{laps:[lap(0)]}))).resolves.toBeDefined();
    await error(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:2})],[],{laps:[lap(0)]})),"lap_slice_invalid");
    await error(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:1}),session(1,2,3,{firstLapIndex:null,numLaps:1})],[],{laps:[lap(0),lap(1)]})),"lap_slice_invalid");
    await error(map(decoded([session(0,0,1,{firstLapIndex:null,numLaps:1})],[],{activity:{timestamp:null,localTimestamp:null,numSessions:2,type:null,event:null,eventType:null},laps:[lap(0)]})),"lap_slice_invalid");
    await error(map(decoded([baseSession],[],{laps:[lap(0,{firstLengthIndex:0,numLengths:null})]})),"length_slice_invalid");
    await error(map(decoded([baseSession],[],{laps:[lap(0,{firstLengthIndex:null,numLengths:1})],lengths:[length(0)]})),"length_slice_invalid");
    await error(map(decoded([baseSession],[],{laps:[baseLap],lengths:[length(0,{lengthType:"idle"})]})),"active_length_count_mismatch");
  });
  it("keeps total source-error precedence for compound failures",async()=>{
    const badActivity={timestamp:NaN,localTimestamp:null,numSessions:null,type:null,event:null,eventType:null} satisfies DecodedActivity;
    await error(map(decoded([],[],{activity:badActivity})),"missing_session");
    await error(map(decoded([session(0,NaN,1,{sport:null})],[])),"invalid_date");
    await error(map(decoded([session(0,0,1,{sport:"bad",firstLapIndex:0,numLaps:null})],[])),"invalid_enum");
    await error(map(decoded([session(0,0,1)],[record(0,0,{timestamp:null}),record(1,2)])),"record_time_missing");
    await error(map(decoded([session(0,0,1),session(1,2,3)],[record(0,1.5),record(1,2.5)])),"record_unassigned");
  });
  it("derives baseline distances only for eligible pool sessions",async()=>{
    const poolSession=session(0,1000,1002,{sport:"swimming",subSport:"lap_swimming",totalDistance:100,firstLapIndex:0,numLaps:1});
    const poolLap=lap(0,{firstLengthIndex:0,numLengths:3,numActiveLengths:2});
    const out=await map(decoded([poolSession],[],{laps:[poolLap],lengths:[length(0,{lengthType:"active"}),length(1,{lengthType:"idle"}),length(2,{lengthType:"active"})]}));
    expect(out.activity.sessions[0]!.distance_m).toBe(100);
    expect(out.activity.swimLengths.map((item)=>item.distance_m)).toEqual([50,0,50]);
  });
  it("leaves open-water, generic swimming, and cycling length distances null",async()=>{
    for(const [sport,subSport] of [["swimming","open_water"],["swimming","generic"],["cycling","generic"]] as const){
      const source=session(0,1000,1002,{sport,subSport,totalDistance:100,firstLapIndex:0,numLaps:1});
      const out=await map(decoded([source],[],{laps:[lap(0,{firstLengthIndex:0,numLengths:3,numActiveLengths:2})],lengths:[length(0,{lengthType:"active"}),length(1,{lengthType:"idle"}),length(2,{lengthType:"active"})]}));
      expect(out.activity.sessions[0]!.distance_m).toBe(100);
      expect(out.activity.swimLengths.map((item)=>item.distance_m)).toEqual([null,null,null]);
      expect(out.activity.poolSessions).toEqual([]);
    }
  });
  it("keeps a no-length lap-swim session ineligible",async()=>{
    const out=await map(decoded([session(0,1000,1002,{sport:"swimming",subSport:"lap_swimming",totalDistance:100,firstLapIndex:null,numLaps:0})],[]));
    expect(out.activity.sessions[0]!.distance_m).toBe(100);
    expect(out.activity.swimLengths).toEqual([]);
    expect(out.activity.poolSessions).toEqual([]);
  });
  it("retains original pool inputs for transactional correction and emits no streams or logs for zero records",async()=>{
    const source=session(0,1000,1002,{sport:"swimming",subSport:"lap_swimming",totalDistance:100,firstLapIndex:0,numLaps:1});
    const out=await map(decoded([source],[],{laps:[lap(0,{firstLengthIndex:0,numLengths:3,numActiveLengths:2})],lengths:[length(0,{lengthType:"active"}),length(1,{lengthType:"idle"}),length(2,{lengthType:"active"})]}));
    expect(out.activity.poolSessions).toEqual([{sessionKey:out.activity.sessions[0]!.session_key,sourceSessionDistanceM:100,lengths:out.activity.swimLengths.map((item,index)=>({lengthKey:item.length_key,lengthType:index===1?"idle":"active"}))}]);
    expect(out.activity.streams).toEqual([]);
    expect(out.activity.repairLogs).toEqual([]);
  });
});
