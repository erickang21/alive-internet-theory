// Zero-dependency static file server, used only to review the sidepanel UI
// outside the extension. Chrome refuses `<script type="module">` over file://
// (the origin is "null", so relative imports fail CORS), so the demo harnesses
// can only be opened through a server.
//
//   npm run demo
//
// Two harnesses live here - the AI filter sidebar and the fact-check card - so
// the index below links both rather than either one claiming the default route.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Served root is frontend/, so a page can reach its sibling .js/.css modules.
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PORT = Number(process.env.PORT) || 8787;

const HARNESSES = [
  ["/src/sidepanel/demo.html", "AI video filter sidebar"],
  ["/src/sidepanel/factcheck-demo.html", "Fact-check card"],
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function indexPage() {
  const links = HARNESSES.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join(
    "\n      ",
  );
  return `<!doctype html>
<meta charset="utf-8">
<title>Alive Internet Theory - demo harnesses</title>
<style>
  body { font: 14px/1.5 "Segoe UI", sans-serif; background: #111; color: #eee; padding: 32px; }
  a { color: #7aa2f7; }
</style>
<h1>Demo harnesses</h1>
<ul>
      ${links}
</ul>`;
}

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
  const full = resolve(join(ROOT, normalize(decoded)));
  // Block path traversal: the resolved path must stay under ROOT.
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  const requested = (req.url ?? "/").split("?")[0];
  if (requested === "/") {
    res.writeHead(200, { "Content-Type": MIME_TYPES[".html"] }).end(indexPage());
    return;
  }

  const path = resolveRequestPath(req.url ?? "/");
  if (!path) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
    return;
  }

  try {
    const info = await stat(path);
    const filePath = info.isDirectory() ? join(path, "index.html") : path;
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Demo harnesses: http://localhost:${PORT}/`);
  for (const [href, label] of HARNESSES) {
    console.log(`  ${label}: http://localhost:${PORT}${href}`);
  }
  console.log("Ctrl+C to stop.");
});
