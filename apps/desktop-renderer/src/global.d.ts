interface EnduragentAuth {
  getDaemonConnection(): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly token: string;
  }>;
}

interface Window {
  readonly enduragentAuth: EnduragentAuth;
}
