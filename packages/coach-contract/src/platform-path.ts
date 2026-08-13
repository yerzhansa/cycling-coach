import { z } from "zod";

export function isPlatformAbsolutePath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (value.startsWith("/")) return true;
  if (/^[A-Za-z]:\\/.test(value)) return true;
  if (!value.startsWith("\\\\")) return false;
  const [server, share] = value.slice(2).split("\\");
  return server !== "" && share !== undefined && share !== "";
}

export const PlatformAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isPlatformAbsolutePath, "path must be absolute");
