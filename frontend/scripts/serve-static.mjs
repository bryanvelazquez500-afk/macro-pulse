// Serves the static export in out/ (or redirects to REDIRECT_TO) for the original Node web service.
// No dependencies: node:http + node:fs.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "..", "out");
const REDIRECT_TO = process.env.REDIRECT_TO?.replace(/\/+$/, "");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
  ".woff2": "font/woff2", ".map": "application/json",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (REDIRECT_TO) {
    res.writeHead(301, { Location: REDIRECT_TO + url.pathname + url.search });
    return res.end();
  }
  let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!path.startsWith(ROOT)) return res.writeHead(400).end();
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path) && existsSync(`${path}.html`)) path = `${path}.html`;
  if (!existsSync(path)) path = join(ROOT, "404.html");
  const immutable = url.pathname.startsWith("/_next/static/");
  res.writeHead(path.endsWith("404.html") ? 404 : 200, {
    "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(path).pipe(res);
}).listen(Number(process.env.PORT) || 3000, () => console.log(`Serving ${REDIRECT_TO ? `redirect → ${REDIRECT_TO}` : ROOT}`));
