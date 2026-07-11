import { sortKeys } from "../store/canonical-json.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}
