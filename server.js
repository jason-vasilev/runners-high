import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// Whitelist of directories we'll serve, mapped to filesystem roots.
const ROOTS = {
  "/photos/": path.join(__dirname, "photos"),
  "/thumbs/": path.join(__dirname, "thumbs"),
  "/mids/":   path.join(__dirname, "mids"),
  "/data/":   path.join(__dirname, "data"),
};
const PUBLIC_ROOT = path.join(__dirname, "public");

function resolveSafe(root, urlPath, prefix) {
  const rel = decodeURIComponent(urlPath.slice(prefix.length));
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null; // path traversal guard
  return full;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];

  for (const [prefix, root] of Object.entries(ROOTS)) {
    if (urlPath.startsWith(prefix)) {
      const full = resolveSafe(root, urlPath, prefix);
      if (!full) return send(res, 400, "Bad request");
      return serveFile(req, res, full);
    }
  }

  // Default: serve from public/
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const full = path.normalize(path.join(PUBLIC_ROOT, rel));
  if (!full.startsWith(PUBLIC_ROOT)) return send(res, 400, "Bad request");
  serveFile(req, res, full);
});

server.listen(PORT, () => {
  console.log(`Runner's High dev server → http://localhost:${PORT}`);
});
