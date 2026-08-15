import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./windows-installed-package.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
