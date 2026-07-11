import { open, rename, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export async function writePortFile(portFilePath: string, port: number): Promise<void> {
  const serialized = `${port}\n`;
  const suffix = randomBytes(4).toString("hex");
  const tempPath = `${portFilePath}.tmp.${suffix}`;

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(tempPath, "w", 0o600);
    await fh.writeFile(serialized, "utf-8");
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tempPath, portFilePath);
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        /* already in the error path */
      }
    }
    try {
      await unlink(tempPath);
    } catch {
      /* temp sibling may not exist */
    }
    throw err;
  }
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
