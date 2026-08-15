import { writeSync } from "node:fs";

const key = Symbol.for("enduragent.s8a.nativeReallyExit");
const nativeReallyExit = process.reallyExit;

const invalidCapture =
  typeof nativeReallyExit !== "function" || Object.prototype.hasOwnProperty.call(globalThis, key);

if (invalidCapture) {
  try {
    writeSync(process.stderr.fd, "s8a native exit capture failed\n");
  } catch {}
  process.exitCode = 2;
  if (typeof nativeReallyExit === "function") nativeReallyExit.call(process, 2);
} else {
  Object.defineProperty(globalThis, key, {
    value: nativeReallyExit.bind(process),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
