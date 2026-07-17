import { sortKeys } from "../store/canonical-json.js";
import { H, compareUtf8, encodeUtf8Strict } from "../store/derived-key.js";
import type { CryptoPort } from "../ports/crypto.js";
import type { ActivityRows, LapRow, SessionRow, StreamRow, SwimLengthRow } from "../store/activity-repository.js";
import { encodeStream } from "./stream-codec.js";
import { rescalePoolDistances, type PoolLengthDistanceInput } from "./pool-size-rescale.js";
import { runRepairChain } from "./repair/chain.js";
import type { RepairFixerSettings } from "./repair/types.js";
import {
  FitSourceError,
  type DecodedDeveloperField,
  type DecodedFitFile,
  type FitEnumInput,
  type FitJsonValue,
  type MappedFitArtifact,
} from "./types.js";

export interface MapFitArtifactInput {
  readonly crypto: CryptoPort;
  readonly rawSha256: string;
  readonly rawByteLength: number;
  readonly archivePath: string | null;
  readonly decoded: DecodedFitFile;
  readonly repairSettings?: RepairFixerSettings;
}

const SPORT: Readonly<Record<number, string>> = Object.freeze({
  0:"generic",1:"running",2:"cycling",3:"transition",4:"fitness_equipment",5:"swimming",6:"basketball",7:"soccer",8:"tennis",9:"american_football",10:"training",11:"walking",12:"cross_country_skiing",13:"alpine_skiing",14:"snowboarding",15:"rowing",16:"mountaineering",17:"hiking",18:"multisport",19:"paddling",20:"flying",21:"e_biking",22:"motorcycling",23:"boating",24:"driving",25:"golf",26:"hang_gliding",27:"horseback_riding",28:"hunting",29:"fishing",30:"inline_skating",31:"rock_climbing",32:"sailing",33:"ice_skating",34:"sky_diving",35:"snowshoeing",36:"snowmobiling",37:"stand_up_paddleboarding",38:"surfing",39:"wakeboarding",40:"water_skiing",41:"kayaking",42:"rafting",43:"windsurfing",44:"kitesurfing",45:"tactical",46:"jumpmaster",47:"boxing",48:"floor_climbing",53:"diving",254:"all",
});
const SUB_SPORT: Readonly<Record<number, string>> = Object.freeze({
  0:"generic",1:"treadmill",2:"street",3:"trail",4:"track",5:"spin",6:"indoor_cycling",7:"road",8:"mountain",9:"downhill",10:"recumbent",11:"cyclocross",12:"hand_cycling",13:"track_cycling",14:"indoor_rowing",15:"elliptical",16:"stair_climbing",17:"lap_swimming",18:"open_water",19:"flexibility_training",20:"strength_training",21:"warm_up",22:"match",23:"exercise",24:"challenge",25:"indoor_skiing",26:"cardio_training",27:"indoor_walking",28:"e_bike_fitness",29:"bmx",30:"casual_walking",31:"speed_walking",32:"bike_to_run_transition",33:"run_to_bike_transition",34:"swim_to_bike_transition",35:"atv",36:"motocross",37:"backcountry",38:"resort",39:"rc_drone",40:"wingsuit",41:"whitewater",42:"skate_skiing",43:"yoga",44:"pilates",45:"indoor_running",46:"gravel_cycling",47:"e_bike_mountain",48:"commuting",49:"mixed_surface",50:"navigate",51:"track_me",52:"map",53:"single_gas_diving",54:"multi_gas_diving",55:"gauge_diving",56:"apnea_diving",57:"apnea_hunting",58:"virtual_activity",59:"obstacle",254:"all",
});
const TRIGGER: Readonly<Record<number, string>> = Object.freeze({0:"activity_end",1:"manual",2:"auto_multi_sport",3:"fitness_equipment"});
const SWIM_STROKE: Readonly<Record<number, string>> = Object.freeze({0:"freestyle",1:"backstroke",2:"breaststroke",3:"butterfly",4:"drill",5:"mixed",6:"im"});
const LENGTH_TYPE: Readonly<Record<number, string>> = Object.freeze({0:"idle",1:"active"});

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase().replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeEnum(value: FitEnumInput, table: Readonly<Record<number, string>>, optional: boolean, unknownInteger = false): string | null {
  if (value === null) return optional ? null : null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new FitSourceError("invalid_enum");
    const known = table[value];
    if (known !== undefined) return known;
    if (unknownInteger) return `unknown:${value.toString()}`;
    throw new FitSourceError("invalid_enum");
  }
  if (typeof value !== "string") throw new FitSourceError("invalid_enum");
  const normalized = normalizeText(value);
  if (normalized.length === 0) throw new FitSourceError("invalid_enum");
  if (Object.values(table).includes(normalized)) return normalized;
  throw new FitSourceError("invalid_enum");
}

function dateValue(value: number | null, integer: boolean): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new FitSourceError("invalid_date");
}
function finite(value: number | null, nonnegative = false, safeInteger = false): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (nonnegative && value < 0) || (safeInteger && !Number.isSafeInteger(value))) throw new FitSourceError("invalid_numeric");
}
function duration(value: number | null): number | null {
  if (value === null) return null;
  finite(value, true);
  const rounded = Math.floor(value + 0.5);
  if (!Number.isSafeInteger(rounded)) throw new FitSourceError("invalid_numeric");
  return rounded;
}
function distance(value: number | null): number | null { finite(value, true); return value; }

function validateDates(decoded: DecodedFitFile): void {
  for (const f of decoded.fileIds) dateValue(f.timeCreated, true);
  if (decoded.activity) { dateValue(decoded.activity.timestamp, true); dateValue(decoded.activity.localTimestamp, true); }
  for (const s of decoded.sessions) { dateValue(s.startTime, true); dateValue(s.timestamp, true); }
  for (const l of decoded.laps) { dateValue(l.startTime, true); dateValue(l.timestamp, true); }
  for (const l of decoded.lengths) { dateValue(l.startTime, true); dateValue(l.timestamp, true); }
  for (const r of decoded.records) dateValue(r.timestamp, false);
  for (const e of decoded.events) dateValue(e.timestamp, true);
}

function validateNumerics(decoded: DecodedFitFile): void {
  for (const f of decoded.fileIds) finite(f.serialNumber, false, true);
  if (decoded.activity) finite(decoded.activity.numSessions, true, true);
  for (const s of decoded.sessions) {
    finite(s.totalElapsedTime, true); finite(s.totalTimerTime, true); finite(s.totalMovingTime, true); finite(s.totalDistance, true);
  }
  for (const l of decoded.laps) {
    finite(l.totalElapsedTime, true); finite(l.totalTimerTime, true); finite(l.totalDistance, true);
  }
  for (const l of decoded.lengths) {
    finite(l.totalElapsedTime, true); finite(l.totalTimerTime, true); finite(l.totalStrokes, true, true);
  }
  for (const r of decoded.records) {
    finite(r.positionLat); finite(r.positionLong); finite(r.distance); finite(r.enhancedAltitude); finite(r.altitude);
    finite(r.enhancedSpeed); finite(r.speed); finite(r.heartRate); finite(r.cadence); finite(r.fractionalCadence);
    finite(r.power); finite(r.temperature); finite(r.stanceTime); finite(r.stanceTimeBalance); finite(r.verticalOscillation);
    finite(r.verticalRatio); finite(r.stepLength); finite(r.leftRightBalance, true, true); finite(r.respirationRate);
    if (r.leftRightBalance !== null && r.leftRightBalance > 127) throw new FitSourceError("invalid_numeric");
  }
  for (const e of decoded.events) finite(e.data);
}

function validateSlice(first: number | null, count: number | null, total: number, code: "lap_slice_invalid" | "length_slice_invalid"): readonly [number, number] {
  if (count === null) {
    if (first !== null) throw new FitSourceError(code);
    return [0, 0];
  }
  if (!Number.isSafeInteger(count) || count < 0) throw new FitSourceError(code);
  if (count === 0) {
    const start = first === null ? 0 : first;
    if (!Number.isSafeInteger(start) || start < 0 || start > total) throw new FitSourceError(code);
    return [start, start];
  }
  if (first === null || !Number.isSafeInteger(first) || first < 0 || first + count > total) throw new FitSourceError(code);
  return [first, first + count];
}

function applicationIds(decoded: DecodedFitFile): Map<number, string> {
  const result = new Map<number, string>();
  for (const item of decoded.developerDataIds) {
    const index = item.developerDataIndex;
    if (!Number.isSafeInteger(index) || index < 0) throw new FitSourceError("developer_identity_invalid");
    let id = `idx-${index}`;
    if (item.applicationId !== null) {
      if (item.applicationId.length !== 16 || item.applicationId.some((b) => !Number.isSafeInteger(b) || b < 0 || b > 255)) throw new FitSourceError("developer_identity_invalid");
      id = item.applicationId.map((b) => b.toString(16).padStart(2,"0")).join("");
    }
    const previous = result.get(index);
    if (previous !== undefined && previous !== id) throw new FitSourceError("developer_identity_conflict");
    result.set(index, id);
  }
  return result;
}

function normalizedDeveloperName(name: string | null, fieldNumber: number): string {
  if (name === null || name.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu,"_").length === 0) return `field-${fieldNumber}`;
  const normalized = name.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu,"_");
  encodeUtf8Strict(normalized);
  let out = "";
  for (const char of normalized) {
    if (/^[a-z0-9._-]$/.test(char)) out += char;
    else for (const byte of encodeUtf8Strict(char)) out += `%${byte.toString(16).padStart(2,"0")}`;
  }
  return out.length === 0 ? `field-${fieldNumber}` : out;
}

function jsonSafe(value: unknown, ancestors = new Set<object>()): FitJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FitSourceError("developer_identity_invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new FitSourceError("developer_identity_invalid");
  if (ancestors.has(value)) throw new FitSourceError("developer_identity_invalid");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, ancestors));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new FitSourceError("developer_identity_invalid");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new FitSourceError("developer_identity_invalid");
    const output: Record<string, FitJsonValue> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new FitSourceError("developer_identity_invalid");
      output[key] = jsonSafe(descriptor.value, ancestors);
    }
    return output;
  } finally { ancestors.delete(value); }
}

interface DeveloperEntry {
  readonly nativeMessageType: number;
  readonly developer_data_index: number;
  readonly field_definition_number: number;
  readonly application_id: string;
  readonly normalized_name: string;
  readonly units: string | null;
  readonly value: FitJsonValue;
  readonly canonical: string;
  readonly channel: string;
}

function compareDeveloper(a: DeveloperEntry, b: DeveloperEntry): number {
  if (a.nativeMessageType !== b.nativeMessageType) return a.nativeMessageType < b.nativeMessageType ? -1 : 1;
  if (a.developer_data_index !== b.developer_data_index) return a.developer_data_index < b.developer_data_index ? -1 : 1;
  if (a.field_definition_number !== b.field_definition_number) return a.field_definition_number < b.field_definition_number ? -1 : 1;
  let c = compareUtf8(a.application_id,b.application_id) || compareUtf8(a.normalized_name,b.normalized_name);
  if (c !== 0) return c;
  if (a.units !== b.units) { if (a.units === null) return -1; if (b.units === null) return 1; c = compareUtf8(a.units,b.units); if (c) return c; }
  return compareUtf8(a.canonical,b.canonical);
}

function developerEntries(fields: readonly DecodedDeveloperField[], ids: Map<number,string>, cross: Map<string,string>): DeveloperEntry[] {
  const byIdentity = new Map<string, DeveloperEntry>();
  for (const field of fields) {
    const { nativeMessageType, developer_data_index: index, field_definition_number: number } = field;
    if (![nativeMessageType,index,number].every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) throw new FitSourceError("developer_identity_invalid");
    if (field.field_name !== null && typeof field.field_name !== "string") throw new FitSourceError("developer_identity_invalid");
    if (field.units !== null && typeof field.units !== "string") throw new FitSourceError("developer_identity_invalid");
    const application_id = ids.get(index) ?? `idx-${index}`;
    const normalized_name = normalizedDeveloperName(field.field_name, number);
    const value = jsonSafe(field.value);
    const canonical = JSON.stringify(sortKeys(value));
    const base = `${nativeMessageType}:${index}:${number}`;
    const metadata = JSON.stringify([application_id,normalized_name,field.units]);
    const priorMetadata = cross.get(base);
    if (priorMetadata !== undefined && priorMetadata !== metadata) throw new FitSourceError("developer_identity_conflict");
    cross.set(base, metadata);
    const entry: DeveloperEntry = { nativeMessageType, developer_data_index:index, field_definition_number:number, application_id, normalized_name, units:field.units, value, canonical, channel:`dev:${application_id}:${index}:${number}:${normalized_name}` };
    const prior = byIdentity.get(base);
    if (prior !== undefined) {
      if (prior.canonical !== canonical || metadata !== JSON.stringify([prior.application_id,prior.normalized_name,prior.units])) throw new FitSourceError("developer_identity_conflict");
    } else byIdentity.set(base, entry);
  }
  return [...byIdentity.values()].sort(compareDeveloper);
}

function summaryEntry(entry: DeveloperEntry): Record<string, FitJsonValue> {
  return { nativeMessageType:entry.nativeMessageType, developer_data_index:entry.developer_data_index, field_definition_number:entry.field_definition_number, application_id:entry.application_id, normalized_name:entry.normalized_name, units:entry.units, value:entry.value };
}
function canonicalSummary(value: unknown): string { return JSON.stringify(sortKeys(value)); }

function localDate(start: number, offset: number | null): number {
  const date = new Date((start + (offset ?? 0)) * 1000);
  if (!Number.isFinite(date.getTime())) throw new FitSourceError("invalid_date");
  return date.getUTCFullYear()*10000 + (date.getUTCMonth()+1)*100 + date.getUTCDate();
}

const NATIVE_CHANNELS: readonly [keyof DecodedFitFile["records"][number], string][] = [
  ["positionLat","lat"],["positionLong","lng"],["distance","distance"],["heartRate","heart_rate"],
  ["cadence","cadence"],["fractionalCadence","fractional_cadence"],["power","power"],["temperature","temperature"],
  ["stanceTime","stance_time"],["stanceTimeBalance","stance_time_balance"],["verticalOscillation","vertical_oscillation"],
  ["verticalRatio","vertical_ratio"],["stepLength","step_length"],["leftRightBalance","left_right_balance"],["respirationRate","respiration_rate"],
];

export async function mapFitArtifact(input: MapFitArtifactInput): Promise<MappedFitArtifact> {
  if (!/^[0-9a-f]{64}$/.test(input.rawSha256) || !Number.isSafeInteger(input.rawByteLength) || input.rawByteLength < 0) throw new RangeError("invalid raw artifact metadata");
  const d = input.decoded;
  if (d.sessions.length === 0) throw new FitSourceError("missing_session");
  validateDates(d);
  validateNumerics(d);

  const sports: string[] = [], subSports: (string|null)[] = [], triggers: (string|null)[] = [];
  for (const s of d.sessions) {
    sports.push(normalizeEnum(s.sport,SPORT,false) ?? "");
    subSports.push(normalizeEnum(s.subSport,SUB_SPORT,true));
    triggers.push(normalizeEnum(s.trigger,TRIGGER,true,true));
  }
  const strokes = d.lengths.map((l) => normalizeEnum(l.swimStroke,SWIM_STROKE,true));
  const lengthTypes = d.lengths.map((l) => normalizeEnum(l.lengthType,LENGTH_TYPE,true));

  let tzOffset: number | null = null;
  if (d.activity?.timestamp !== null && d.activity?.timestamp !== undefined && d.activity.localTimestamp !== null) {
    tzOffset = d.activity.localTimestamp - d.activity.timestamp;
    if (!Number.isSafeInteger(tzOffset)) throw new FitSourceError("invalid_activity_offset");
  }
  for (const s of d.sessions) if (s.startTime === null) throw new FitSourceError("missing_session_start");
  for (const s of d.sessions) if (s.timestamp === null) throw new FitSourceError("missing_session_end");
  for (let i=0;i<d.sessions.length;i++) if (d.sessions[i].sport === null || sports[i] === "") throw new FitSourceError("missing_session_sport");
  const singleSessionShape=d.sessions.length===1&&(d.activity?.numSessions===null||d.activity?.numSessions===undefined||d.activity.numSessions===1);
  // FIT timestamps are whole seconds while elapsed time may retain a fractional terminal second.
  const sessionEnds=d.sessions.map((s)=>singleSessionShape&&s.timestamp===s.startTime&&s.totalElapsedTime!==null&&s.totalElapsedTime>0
    ? (s.startTime as number)+Math.ceil(s.totalElapsedTime)
    : s.timestamp as number);
  for (let i=0;i<d.sessions.length;i++) {
    const s=d.sessions[i];
    if ((s.startTime as number) > sessionEnds[i]) throw new FitSourceError("invalid_session_range");
    if (i+1<d.sessions.length && sessionEnds[i] > (d.sessions[i+1].startTime as number)) throw new FitSourceError("invalid_session_range");
  }

  const sessionLapSlices = d.sessions.map((s) => singleSessionShape&&d.laps.length>0&&s.firstLapIndex===null&&(s.numLaps===null||s.numLaps===d.laps.length)
    ? [0,d.laps.length] as const
    : validateSlice(s.firstLapIndex,s.numLaps,d.laps.length,"lap_slice_invalid"));
  const lapOwners = Array<number>(d.laps.length).fill(0);
  for (const [start,end] of sessionLapSlices) for(let i=start;i<end;i++) lapOwners[i]++;
  if (lapOwners.some((n)=>n!==1)) throw new FitSourceError("lap_slice_invalid");
  const lapLengthSlices = d.laps.map((l) => validateSlice(l.firstLengthIndex,l.numLengths,d.lengths.length,"length_slice_invalid"));
  const lengthOwners = Array<number>(d.lengths.length).fill(0);
  for (const [start,end] of lapLengthSlices) for(let i=start;i<end;i++) lengthOwners[i]++;
  if (lengthOwners.some((n)=>n!==1)) throw new FitSourceError("length_slice_invalid");
  for (let i=0;i<d.laps.length;i++) {
    const expected=d.laps[i].numActiveLengths;
    if (expected !== null) {
      if (!Number.isSafeInteger(expected) || expected<0) throw new FitSourceError("active_length_count_mismatch");
      const [start,end]=lapLengthSlices[i];
      let actual=0; for(let j=start;j<end;j++) if(lengthTypes[j]==="active") actual++;
      if(actual!==expected) throw new FitSourceError("active_length_count_mismatch");
    }
  }

  const ids=applicationIds(d), metadata=new Map<string,string>();
  const sessionDevelopers=d.sessions.map((s)=>developerEntries(s.developerFields,ids,metadata));
  const lapDevelopers=d.laps.map((l)=>developerEntries(l.developerFields,ids,metadata));
  const recordDevelopers=d.records.map((r)=>developerEntries(r.developerFields,ids,metadata));

  if (d.records.some((r)=>r.timestamp===null)) throw new FitSourceError("record_time_missing");
  const recordOwners=d.records.map((r)=>d.sessions.map((s,i)=>{
    const t=r.timestamp as number, start=s.startTime as number, end=sessionEnds[i];
    return t>=start && (i===d.sessions.length-1 ? t<=end : t<end);
  }).filter(Boolean).length);
  if(recordOwners.some((n)=>n===0)) throw new FitSourceError("record_unassigned");
  if(recordOwners.some((n)=>n>1)) throw new FitSourceError("record_ambiguous");
  const assigned=d.sessions.map(()=>[] as number[]);
  for(let r=0;r<d.records.length;r++) {
    const t=d.records[r].timestamp as number;
    const owner=d.sessions.findIndex((s,i)=>t>=(s.startTime as number)&&(i===d.sessions.length-1?t<=sessionEnds[i]:t<sessionEnds[i]));
    assigned[owner].push(r);
  }
  for(const indexes of assigned) for(let i=1;i<indexes.length;i++) if((d.records[indexes[i]].timestamp as number)<=(d.records[indexes[i-1]].timestamp as number)) throw new FitSourceError("record_time_nonmonotonic");

  const workoutKey=await H(input.crypto,"workout",input.rawSha256);
  const sessionKeys=await Promise.all(d.sessions.map((_,i)=>H(input.crypto,"session",workoutKey,i)));
  const sessions: SessionRow[]=[]; const laps: LapRow[]=[]; const swimLengths: SwimLengthRow[]=[]; const streams: StreamRow[]=[];
  const repairLogs: ActivityRows["repairLogs"][number][]=[];
  const poolSessions: ActivityRows["poolSessions"][number][]=[];
  for(let i=0;i<d.sessions.length;i++) {
    const source=d.sessions[i], key=sessionKeys[i];
    sessions.push({ session_key:key,workout_key:workoutKey,session_seq:i,sport:sports[i],sub_sport:subSports[i],start_utc:source.startTime as number,tz_offset_s:tzOffset,local_date_key:localDate(source.startTime as number,tzOffset),elapsed_s:duration(source.totalElapsedTime),timer_s:duration(source.totalTimerTime),moving_s:duration(source.totalMovingTime),distance_m:distance(source.totalDistance),is_transition:sports[i]==="transition"?1:0,summary_json:canonicalSummary({developer_fields:sessionDevelopers[i].map(summaryEntry),trigger:triggers[i]}) });
    const sessionLengthStart=swimLengths.length;
    const [lapStart,lapEnd]=sessionLapSlices[i];
    for(let g=lapStart;g<lapEnd;g++) {
      const sourceLap=d.laps[g], lapKey=await H(input.crypto,"lap",key,g);
      laps.push({lap_key:lapKey,session_key:key,lap_seq:g,start_utc:sourceLap.startTime,elapsed_s:duration(sourceLap.totalElapsedTime),timer_s:duration(sourceLap.totalTimerTime),distance_m:distance(sourceLap.totalDistance),summary_json:canonicalSummary({developer_fields:lapDevelopers[g].map(summaryEntry)})});
      const [lengthStart,lengthEnd]=lapLengthSlices[g];
      for(let sourceIndex=lengthStart;sourceIndex<lengthEnd;sourceIndex++) {
        const sourceLength=d.lengths[sourceIndex], seq=sourceIndex-lengthStart;
        swimLengths.push({length_key:await H(input.crypto,"swim_length",lapKey,seq),lap_key:lapKey,length_seq:seq,start_utc:sourceLength.startTime,elapsed_s:duration(sourceLength.totalElapsedTime),timer_s:duration(sourceLength.totalTimerTime),strokes:sourceLength.totalStrokes,stroke_type:strokes[sourceIndex],length_type:lengthTypes[sourceIndex],distance_m:null});
      }
    }
    const ownedLengths=swimLengths.slice(sessionLengthStart);
    if(sports[i]==="swimming"&&subSports[i]==="lap_swimming"&&ownedLengths.length>0){
      const lengthInputs:PoolLengthDistanceInput[]=ownedLengths.map((length)=>{
        if(length.length_type!=="active"&&length.length_type!=="idle") throw new FitSourceError("invalid_enum");
        return {lengthKey:length.length_key,lengthType:length.length_type};
      });
      const scaled=rescalePoolDistances({sourceSessionDistanceM:distance(source.totalDistance),lengths:lengthInputs,correctedPoolLengthM:null});
      sessions[i]={...sessions[i]!,distance_m:scaled.sessionDistanceM};
      const byKey=new Map(scaled.lengths.map((length)=>[length.lengthKey,length.distanceM]));
      for(let lengthIndex=sessionLengthStart;lengthIndex<swimLengths.length;lengthIndex++){
        const length=swimLengths[lengthIndex]!;
        swimLengths[lengthIndex]={...length,distance_m:byKey.get(length.length_key)??null};
      }
      poolSessions.push({sessionKey:key,sourceSessionDistanceM:distance(source.totalDistance),lengths:lengthInputs});
    }
    const indexes=assigned[i];
    if(indexes.length>0) {
      const values=new Map<string,(number|null)[]>();
      values.set("time",indexes.map((x)=>d.records[x].timestamp));
      for(const [property,channel] of NATIVE_CHANNELS) values.set(channel,indexes.map((x)=>d.records[x][property] as number|null));
      values.set("altitude",indexes.map((x)=>d.records[x].enhancedAltitude ?? d.records[x].altitude));
      values.set("speed",indexes.map((x)=>d.records[x].enhancedSpeed ?? d.records[x].speed));
      for(let slot=0;slot<indexes.length;slot++) for(const entry of recordDevelopers[indexes[slot]]) {
        if(typeof entry.value!=="number") continue;
        let channel=values.get(entry.channel); if(!channel){channel=Array<number|null>(indexes.length).fill(null);values.set(entry.channel,channel);} channel[slot]=entry.value;
      }
      const timeValues=values.get("time")!;
      const repairChannels:Record<string,readonly (number|null)[]>={};
      for(const [channel,channelValues] of values){
        if(channel==="time"||channelValues.every((value)=>value===null)) continue;
        repairChannels[channel]=channelValues;
      }
      const repaired=runRepairChain(
        {time:timeValues as readonly number[],channels:repairChannels},
        input.repairSettings,
      );
      for(const log of repaired.logs) for(const change of log.changes) repairLogs.push({sessionKey:key,fixer:log.fixer,channel:change.channel,changedIndices:change.changedIndices,params:log.params});
      const repairedValues=new Map<string,readonly (number|null)[]>([["time",repaired.stream.time],...Object.entries(repaired.stream.channels)]);
      for(const [channel,channelValues] of repairedValues) {
        if(channelValues.length!==repaired.stream.time.length) throw new FitSourceError("stream_alignment_invalid");
        const encoded=encodeStream(channel==="time"?"time":"value",channelValues);
        streams.push({stream_key:await H(input.crypto,"stream",key,channel),session_key:key,channel,encoding:encoded.encoding,sample_rate:null,n:encoded.n,data:encoded.data});
      }
    }
  }
  const firstFile=d.fileIds[0];
  let manufacturer:string|null=null;
  if(firstFile?.manufacturer!==null&&firstFile?.manufacturer!==undefined) {
    if(typeof firstFile.manufacturer!=="string") throw new FitSourceError("invalid_enum");
    manufacturer=normalizeText(firstFile.manufacturer); if(!manufacturer) throw new FitSourceError("invalid_enum");
  }
  let product:string|null=null;
  if(firstFile?.productName!==null&&firstFile?.productName!==undefined&&firstFile.productName.length>0) product=firstFile.productName;
  else if(typeof firstFile?.product==="string") { product=normalizeText(firstFile.product); if(!product) throw new FitSourceError("invalid_enum"); }
  else if(typeof firstFile?.product==="number") { if(!Number.isSafeInteger(firstFile.product)) throw new FitSourceError("invalid_enum"); product=firstFile.product.toString(); }
  const startUtc=Math.min(...d.sessions.map((s)=>s.startTime as number));
  const activity:ActivityRows={workout:{workout_key:workoutKey,start_utc:startUtc,tz_offset_s:tzOffset,name:null,notes:null,is_multisport:d.sessions.length>1?1:0,dedup_cluster_id:input.rawSha256},sessions,laps,swimLengths,streams,repairLogs,poolSessions};
  const logicalArchiveEpochSeconds=firstFile?.timeCreated ?? Math.min(...d.sessions.map((s)=>s.startTime as number)) ?? Math.min(...d.records.map((r)=>r.timestamp as number)) ?? 0;
  return {rawFile:{sha256:input.rawSha256,path:input.archivePath,ext:"fit",bytes:input.rawByteLength,file_id_serial:firstFile?.serialNumber??null,file_id_time_created_utc:firstFile?.timeCreated??null,manufacturer,product},activity,logicalArchiveEpochSeconds};
}

export function withArchivePath(artifact: MappedFitArtifact, archivePath: string): MappedFitArtifact {
  if (archivePath.length===0 || archivePath.startsWith("/") || archivePath.split("/").includes("..")) throw new RangeError("archive path must be relative");
  return {...artifact,rawFile:{...artifact.rawFile,path:archivePath}};
}
