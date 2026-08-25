import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    sqlite: "src/sqlite/index.ts",
    "archive/index": "src/archive/index.ts",
    "chat-attachments/index": "src/chat-attachments/index.ts",
    "chat-attachments/document-reader-worker": "src/chat-attachments/document-reader-worker.ts",
    "chat-attachments/activity-reader-worker": "src/chat-attachments/activity-reader-worker.ts",
    "chat-attachments/media-reader-worker": "src/chat-attachments/media-reader-worker.ts",
    "lock/index": "src/lock/index.ts",
    "store-export/index": "src/store-export/index.ts",
    "home/index": "src/home/index.ts",
    "filesystem/index": "src/filesystem/index.ts",
    "ingest/index": "src/ingest/index.ts",
    "capture-manifest/index": "src/capture-manifest/index.ts",
    "service/index": "src/service/index.ts",
    "coach-dev": "src/cli/coach-dev.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  removeNodeProtocol: false,
});
