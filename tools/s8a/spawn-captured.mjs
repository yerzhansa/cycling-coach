import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [requestPath, resultPath, stdoutPath, stderrPath] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestPath, "utf-8"));
const stdoutChunks = [];
const stderrChunks = [];
let stdoutBytes = 0;
let stderrBytes = 0;
let status = null;
let errorCode;
let overflowStream;
let finished = false;
let timer;

const child = spawn(request.command, request.args, {
  cwd: request.cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.stdout.destroy();
  child.stderr.destroy();
  writeFileSync(stdoutPath, Buffer.concat(stdoutChunks), { mode: 0o600 });
  writeFileSync(stderrPath, Buffer.concat(stderrChunks), { mode: 0o600 });
  writeFileSync(
    resultPath,
    JSON.stringify({ status: errorCode === undefined ? status : null, errorCode, overflowStream }),
    { mode: 0o600 },
  );
}

function stop(code, stream) {
  if (finished || errorCode !== undefined) return;
  errorCode = code;
  overflowStream = stream;
  child.stdout.destroy();
  child.stderr.destroy();
  if (!child.kill(request.killSignal)) setImmediate(finish);
}

function collect(chunk, chunks, bytes, stream) {
  if (finished || errorCode !== undefined) return bytes;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (bytes + buffer.byteLength > request.maxBuffer) {
    stop("ENOBUFS", stream);
    return bytes;
  }
  chunks.push(buffer);
  return bytes + buffer.byteLength;
}

child.stdout.on("data", (chunk) => {
  stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes, "stdout");
});
child.stderr.on("data", (chunk) => {
  stderrBytes = collect(chunk, stderrChunks, stderrBytes, "stderr");
});
child.once("error", (error) => {
  errorCode = typeof error.code === "string" ? error.code : "EHELPER";
  setImmediate(finish);
});
child.once("exit", (code) => {
  status = code;
  setImmediate(finish);
});

timer = setTimeout(() => stop("ETIMEDOUT"), request.timeout);
