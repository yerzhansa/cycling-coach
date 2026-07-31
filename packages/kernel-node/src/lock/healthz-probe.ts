import { get } from "node:http";
import { createConnection } from "node:net";

export type HealthzVerdict =
  | { readonly kind: "healthy"; readonly version: string }
  | { readonly kind: "unresponsive" }
  | { readonly kind: "foreign" };

export type HealthzProbe = (port: number) => Promise<HealthzVerdict>;

export const HEALTHZ_SERVICE_MARKER = "enduragent-store-writer" as const;

const PROBE_TIMEOUT_MS = 1000;

export function classifyHealthzResponse(status: number, body: string): HealthzVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "foreign" };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (obj.service === HEALTHZ_SERVICE_MARKER && typeof obj.version === "string" && obj.version.length > 0) {
      return { kind: "healthy", version: obj.version };
    }
  }
  void status;
  return { kind: "foreign" };
}

export const defaultHealthzProbe: HealthzProbe = (port: number): Promise<HealthzVerdict> =>
  new Promise<HealthzVerdict>((resolve) => {
    let settled = false;
    const done = (verdict: HealthzVerdict): void => {
      if (settled) return;
      settled = true;
      resolve(verdict);
    };

    const req = get(
      { host: "127.0.0.1", port, path: "/healthz", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          done(classifyHealthzResponse(res.statusCode ?? 0, body));
        });
        res.on("error", () => done({ kind: "unresponsive" }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ kind: "unresponsive" });
    });
    req.on("error", () => done({ kind: "unresponsive" }));
  });

export async function isPortBound(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (bound: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(bound);
    };

    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(true));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      done(err.code !== "ECONNREFUSED");
    });
  });
}
