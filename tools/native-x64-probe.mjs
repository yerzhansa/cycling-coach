import { mkdirSync, writeFileSync } from "node:fs";

const PORT = 9222;
const OUT = "probe-out";
mkdirSync(OUT, { recursive: true });

const report = {
  verdict: "infra-error",
  arch: process.env.PROCESSOR_ARCHITECTURE ?? "unknown",
  events: [],
  notes: [],
};

function note(message) {
  report.notes.push(message);
  console.log(message);
}

function finish(verdict, code) {
  report.verdict = verdict;
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`VERDICT=${verdict}`);
  process.exit(code);
}

async function waitForTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "none";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && String(t.url).startsWith("enduragent://"),
      );
      if (page) return page;
      lastError = `targets present but no enduragent:// page: ${targets
        .map((t) => `${t.type}:${t.url}`)
        .join(" | ")}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no CDP page target within ${timeoutMs}ms; last: ${lastError}`);
}

const page = await waitForTarget(90_000);
note(`attached to ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
let crashed = false;
let socketClosed = false;

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method) {
    if (
      msg.method === "Inspector.targetCrashed" ||
      msg.method === "Runtime.exceptionThrown" ||
      msg.method === "Log.entryAdded" ||
      msg.method === "Runtime.consoleAPICalled"
    ) {
      report.events.push({ method: msg.method, params: msg.params });
    }
    if (msg.method === "Inspector.targetCrashed") {
      crashed = true;
      note("Inspector.targetCrashed received");
    }
  }
});
ws.addEventListener("close", () => {
  socketClosed = true;
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (socketClosed) {
      resolve({ error: { message: "socket closed" } });
      return;
    }
    const id = nextId++;
    pending.set(id, resolve);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      reject(error);
    }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: { message: `timeout: ${method}` } });
      }
    }, 15_000);
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await send("Inspector.enable");

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true });
  return res?.result?.result?.value ?? `EVAL-ERROR: ${JSON.stringify(res?.error ?? res?.result?.exceptionDetails ?? res)}`;
}

async function screenshot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  if (res?.result?.data) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.result.data, "base64"));
    note(`${name}.png captured`);
    return true;
  }
  note(`${name}.png FAILED: ${JSON.stringify(res?.error ?? "no data")}`);
  return false;
}

await new Promise((r) => setTimeout(r, 5_000));
report.preClickState = await evaluate(
  `JSON.stringify({bodyChars: document.body.innerText.length, sidebar: !!document.querySelector('nav[aria-label="Main navigation"]')})`,
);
note(`pre-click state: ${report.preClickState}`);
await screenshot("pre-click");

report.clickResult = await evaluate(`(() => {
  const nav = document.querySelector('nav[aria-label="Main navigation"]');
  const buttons = nav ? Array.from(nav.querySelectorAll('button')) : [];
  const target = buttons.find((b) => b.textContent.trim() === 'Settings');
  if (!target) return 'SETTINGS-BUTTON-NOT-FOUND: ' + buttons.map((b) => b.textContent.trim()).join('|');
  target.click();
  return 'CLICKED';
})()`);
note(`click result: ${report.clickResult}`);

if (report.clickResult !== "CLICKED") {
  await screenshot("no-button");
  finish("infra-error", 1);
}

await new Promise((r) => setTimeout(r, 12_000));

if (crashed || socketClosed) {
  report.postClickState = crashed ? "TARGET CRASHED" : "SOCKET CLOSED";
  finish("crashed", 2);
}

report.postClickState = await evaluate(
  `JSON.stringify({bodyChars: document.body.innerText.length, sidebar: !!document.querySelector('nav[aria-label="Main navigation"]'), settingsVisible: document.body.innerText.includes('Settings')})`,
);
note(`post-click state: ${report.postClickState}`);
const shot = await screenshot("post-click");

if (crashed || socketClosed) {
  finish("crashed", 2);
}

let bodyChars = 0;
try {
  bodyChars = JSON.parse(report.postClickState).bodyChars;
} catch {
  finish("infra-error", 1);
}

if (bodyChars > 50 && shot) {
  finish("rendered", 0);
}
finish("blank-no-crash", 3);
