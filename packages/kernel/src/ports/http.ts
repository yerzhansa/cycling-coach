export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

// Minimal fetch-shaped client seam. Self-contained request/response types (not
// the DOM fetch types) so the kernel compiles with no DOM lib.
export interface HttpPort {
  fetch(request: HttpRequest): Promise<HttpResponse>;
}
