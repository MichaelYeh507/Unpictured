import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { type Connect, defineConfig, type Plugin } from "vite";
import { parseWorldFilePath } from "../core/src/worldPackage.ts";

// World packages stay in the repo's gitignored worlds/ folder and are never bundled.
const WORLDS_DIR = fileURLToPath(new URL("../worlds", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
};

/** Serves /worlds/<name>/<file>. Anything else starting /worlds is a 404, never the app page. */
function serveWorlds(): Connect.NextHandleFunction {
  return (request, response, next) => {
    const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!urlPath.toLowerCase().startsWith("/worlds")) {
      next();
      return;
    }
    const parts = parseWorldFilePath(urlPath);
    const filePath = parts === null ? null : path.join(WORLDS_DIR, parts.name, parts.file);
    const stats = filePath === null ? undefined : statSync(filePath, { throwIfNoEntry: false });
    if (filePath === null || stats === undefined || !stats.isFile()) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    response.setHeader(
      "Content-Type",
      CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    );
    response.setHeader("Content-Length", stats.size);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    // pipeline closes the file when the browser disconnects. On a read error it closes the
    // connection too, and the viewer reports the failed load.
    pipeline(createReadStream(filePath), response, () => {});
  };
}

const worlds: Plugin = {
  name: "unpictured-worlds",
  configureServer(server) {
    server.middlewares.use(serveWorlds());
  },
  configurePreviewServer(server) {
    server.middlewares.use(serveWorlds());
  },
};

export default defineConfig({
  plugins: [worlds],
  build: {
    // The page is the 3D view, so three.js (about 530 kB) and Spark (about 2.5 MB) load up
    // front. The budget sits just above that and flags anything unexpected.
    chunkSizeWarningLimit: 3200,
  },
});
