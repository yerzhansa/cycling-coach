import { open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export async function writeTempThenPublish(
  targetPath: string,
  contents: string,
  publish: (tempPath: string, targetPath: string) => Promise<void>,
): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  const tempPath = `${targetPath}.tmp.${suffix}`;

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(tempPath, "w", 0o600);
    await fh.writeFile(contents, "utf-8");
    await fh.sync();
    await fh.close();
    fh = null;
    await publish(tempPath, targetPath);
  } finally {
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
      /* consumed by rename or already gone */
    }
  }
}
