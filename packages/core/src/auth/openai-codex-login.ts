import { spawn } from "node:child_process";
import { note, text, isCancel, log } from "@clack/prompts";
import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredential } from "./profiles.js";

const LOCAL_CALLBACK_FALLBACK_MS = 120_000;

function isHeadless(): boolean {
  if (!process.stdout.isTTY) return true;
  if (process.env.SSH_CONNECTION) return true;
  if (process.platform === "linux" && !process.env.DISPLAY) return true;
  return false;
}

function openUrl(url: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(opener, [url], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  } catch {
    // Fall through — the URL is also printed for manual paste.
  }
}

async function promptForCode(message: string): Promise<string> {
  const value = await text({
    message,
    validate: (v) => (!v ? "Value is required" : undefined),
  });
  if (isCancel(value)) throw new Error("OAuth cancelled by user");
  return typeof value === "string" ? value : "";
}

export async function runCodexLogin(): Promise<OAuthCredential> {
  const headless = isHeadless();

  const creds = await loginOpenAICodex({
    originator: "cycling-coach",
    onAuth: ({ url }) => {
      if (headless) {
        note(
          [
            "Headless environment detected.",
            "Open this URL in a browser on your LOCAL machine,",
            "complete sign-in, then paste the redirect URL back here.",
          ].join("\n"),
          "OpenAI Codex OAuth",
        );
      } else {
        note(
          "A browser will open for OpenAI sign-in.\nIf it doesn't open, copy the URL below:",
          "OpenAI Codex OAuth",
        );
      }
      // Print the URL outside the boxed note so long links are not hard-wrapped
      // with whitespace/newlines inserted by the box renderer.
      console.log(url);
      if (!headless) openUrl(url);
    },
    onPrompt: async (prompt) => await promptForCode(prompt.message),
    onProgress: (msg) => log.info(msg),
    onManualCodeInput: async () => {
      if (!headless) {
        await new Promise((resolve) => setTimeout(resolve, LOCAL_CALLBACK_FALLBACK_MS));
      }
      return await promptForCode("Paste the authorization code (or full redirect URL)");
    },
  });

  return {
    type: "oauth",
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: typeof creds.accountId === "string" ? creds.accountId : undefined,
    email: typeof creds.email === "string" ? creds.email : undefined,
  };
}
