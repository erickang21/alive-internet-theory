// Zero-dependency static server for demo.html.
//
// Chrome refuses to load `<script type="module">` over file:// (the origin is
// "null", so the relative imports fail CORS), which is exactly how someone
// would try to open the demo. Serving it over http fixes that without adding a
// dependency, a bundler step, or a change to build.js.
//
//   npm run demo
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PORT = Number(process.env.PORT) || 877;
const DEMO_PATH = "/src/sidepanel/demo.html";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const requested = urlPath === "/" ? DEMO_PATH : urlPath;

  // Keep the server inside the frontend directory even if the path walks up.
  const filePath = join(ROOT, normalize(requested));
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`AIVideoFilterSidebar demo: http://localhost:${PORT}${DEMO_PATH}`);
  console.log("Ctrl+C to stop.");
});
