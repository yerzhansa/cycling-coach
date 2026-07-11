import { rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { writeTempThenPublish } from "./write-temp.js";

export async function writePortFile(portFilePath: string, port: number): Promise<void> {
  await writeTempThenPublish(portFilePath, `${port}\n`, (tempPath, targetPath) =>
    rename(tempPath, targetPath),
  );
}

export function readPortFile(portFilePath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(portFilePath, "utf-8");
  } catch {
    return null;
  }
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}
