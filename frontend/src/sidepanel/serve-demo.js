// Zero-dependency static file server, used only to review the fact-check UI
// outside the extension. Chrome refuses `<script type="module">` over
// file://, so factcheck-demo.html can only be opened through this server.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at frontend/src/sidepanel/serve-demo.js; serve the whole
// frontend/ directory so the page can reach its sibling .js/.css modules.
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_PAGE = "/src/sidepanel/factcheck-demo.html";
const PORT = Number(process.env.PORT) || 8787;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function resolveRequestPath(url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.split("?")[0]);
  } catch {
    // A malformed escape ("/%E0%A4%A", a lone "%") makes decodeURIComponent
    // throw URIError. The request handler is async with nothing around this
    // call, so an uncaught throw here kills the whole server on one request.
    return null;
  }
  const relative = normalize(decoded === "/" ? DEFAULT_PAGE : decoded);
  const full = resolve(join(ROOT, relative));
  // Block path traversal: the resolved path must stay under ROOT.
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  const path = resolveRequestPath(req.url ?? "/");
  if (!path) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
    return;
  }
  try {
    const info = await stat(path);
    const filePath = info.isDirectory() ? join(path, "index.html") : path;
    const body = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType }).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Fact-check demo: http://localhost:${PORT}${DEFAULT_PAGE}`);
});
