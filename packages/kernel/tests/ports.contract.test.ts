import { describe, expect, it } from "vitest";
import type {
  ClockPort,
  CryptoPort,
  DirEntry,
  FileStat,
  FileSystemPort,
  HttpPort,
  HttpRequest,
  HttpResponse,
  LoggerPort,
  PreparedStatement,
  StoragePort,
  StorageRow,
  StorageRunResult,
} from "../src/ports/index.js";

class FakeFileSystem implements FileSystemPort {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();

  async readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`no such file: ${path}`);
    return data;
  }
  async readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
  async rename(from: string, to: string): Promise<void> {
    this.files.set(to, await this.readFile(from));
    this.files.delete(from);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async list(path: string): Promise<readonly DirEntry[]> {
    return [...this.files.keys()]
      .filter((p) => p.startsWith(`${path}/`))
      .map((p) => ({ name: p.slice(path.length + 1), kind: "file" as const }));
  }
  async stat(path: string): Promise<FileStat | undefined> {
    const data = this.files.get(path);
    if (data) return { kind: "file", size: data.byteLength, mtimeMs: 0 };
    if (this.dirs.has(path)) return { kind: "directory", size: 0, mtimeMs: 0 };
    return undefined;
  }
}

class FakeClock implements ClockPort {
  private mono = 0;
  constructor(private readonly epochMs: number) {}
  now(): number {
    return this.epochMs;
  }
  monotonicNow(): number {
    this.mono += 1;
    return this.mono;
  }
}

class CapturingLogger implements LoggerPort {
  readonly lines: Array<{ level: string; message: string }> = [];
  debug(message: string): void {
    this.lines.push({ level: "debug", message });
  }
  info(message: string): void {
    this.lines.push({ level: "info", message });
  }
  warn(message: string): void {
    this.lines.push({ level: "warn", message });
  }
  error(message: string): void {
    this.lines.push({ level: "error", message });
  }
}

class FakeStorage implements StoragePort {
  readonly execed: string[] = [];
  private userVersion = 0;
  async exec(sql: string): Promise<void> {
    this.execed.push(sql);
    const match = /PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(sql);
    if (match) this.userVersion = Number(match[1]);
  }
  async prepare(sql: string): Promise<PreparedStatement> {
    const uv = this.userVersion;
    return {
      async run(): Promise<StorageRunResult> {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async get(): Promise<StorageRow | undefined> {
        return /user_version/i.test(sql) ? { user_version: uv } : undefined;
      },
      async all(): Promise<readonly StorageRow[]> {
        return [];
      },
    };
  }
  async pragma(source: string): Promise<number | null> {
    return /user_version/i.test(source) ? this.userVersion : null;
  }
  async close(): Promise<void> {}
}

class StubCrypto implements CryptoPort {
  async sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(32).fill(data.byteLength & 0xff);
  }
  async randomBytes(length: number): Promise<Uint8Array> {
    return new Uint8Array(length);
  }
  async pbkdf2(): Promise<Uint8Array> {
    return new Uint8Array(32);
  }
  async aesGcmEncrypt(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }
  async aesGcmDecrypt(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }
}

class StubHttp implements HttpPort {
  async fetch(request: HttpRequest): Promise<HttpResponse> {
    return {
      status: 200,
      headers: { "x-echo": request.method },
      body: new TextEncoder().encode(request.url),
    };
  }
}

describe("kernel ports", () => {
  it("FileSystemPort round-trips text and resolves undefined for an absent path", async () => {
    const fs: FileSystemPort = new FakeFileSystem();
    await fs.mkdir("/store");
    await fs.writeFile("/store/a.txt", "hello");
    expect(await fs.readTextFile("/store/a.txt")).toBe("hello");
    expect(await fs.stat("/store/missing")).toBeUndefined();
    expect((await fs.list("/store")).map((e) => e.name)).toContain("a.txt");
  });

  it("ClockPort exposes wall-clock and a monotonic counter", () => {
    const clock: ClockPort = new FakeClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    const first = clock.monotonicNow();
    const second = clock.monotonicNow();
    expect(first).toBeLessThan(second);
  });

  it("LoggerPort captures leveled lines", () => {
    const logger = new CapturingLogger();
    logger.info("up");
    logger.error("down");
    expect(logger.lines).toEqual([
      { level: "info", message: "up" },
      { level: "error", message: "down" },
    ]);
  });

  it("StoragePort exec/prepare/pragma express the user_version read/apply flow", async () => {
    const storage: StoragePort = new FakeStorage();
    expect(await storage.pragma("user_version")).toBe(0);
    await storage.exec("PRAGMA user_version = 1");
    expect(await storage.pragma("user_version")).toBe(1);
    const stmt = await storage.prepare("PRAGMA user_version");
    expect(await stmt.get()).toEqual({ user_version: 1 });
    await storage.close();
  });

  it("CryptoPort and HttpPort are implementable with the WebCrypto-subset / fetch-shaped surface", async () => {
    const crypto: CryptoPort = new StubCrypto();
    expect((await crypto.sha256(new Uint8Array([1, 2, 3]))).byteLength).toBe(32);
    expect((await crypto.randomBytes(12)).byteLength).toBe(12);
    const http: HttpPort = new StubHttp();
    const res = await http.fetch({ method: "GET", url: "http://127.0.0.1/healthz" });
    expect(res.status).toBe(200);
  });
});
