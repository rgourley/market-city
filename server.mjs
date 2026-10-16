// The server serves the page and the today API from one long-running Node process.
// Use it on your Mac, on Railway or Render, on a VPS, or in Docker. On Vercel, api/today.mjs does the same job.
// The Massive key stays on the server. The page reads today's data from GET /api/today.
// Run: npm start (reads .env.local), or set MASSIVE_API_KEY in the host's environment.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createToday } from "./lib/today.mjs";
import { createExamples } from "./lib/examples.mjs";
import { memoryStore } from "./lib/massive.mjs";
import { isLite, planUniverse, prefixedStore, trackedTickers } from "./lib/plan.mjs";

const PORT = Number(process.env.PORT ?? 8811);
const ROOT = fileURLToPath(new URL(".", import.meta.url));

// universe.json lists the sectors, their tickers and the sample dates. The market data comes from Massive at run time.
// MASSIVE_PLAN=basic turns on lite mode for the free plan.
const lite = isLite(process.env);
const universe = planUniverse(JSON.parse(await readFile(join(ROOT, "universe.json"), "utf8")), lite);
const store = prefixedStore(memoryStore(), lite);
const today = createToday({
  key: process.env.MASSIVE_API_KEY,
  tickers: trackedTickers(universe),
  store,
  lite,
  displayDelayMinutes: Number(process.env.DISPLAY_DELAY_MINUTES ?? 15),
});
const examples = createExamples({ key: process.env.MASSIVE_API_KEY, universe, store });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

// Responses are gzipped when the browser accepts it. Static files are cached in memory by modification time.
const wantsGzip = (req) => /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
function send(req, res, status, headers, body) {
  if (wantsGzip(req) && body.length > 1024) {
    res.writeHead(status, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" });
    res.end(gzipSync(body));
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}
// The cache key is the file's device and inode, not the request path. Different spellings of one path
// (macOS file names ignore case) share one entry, so the cache can hold at most one entry per file in this folder.
const staticCache = new Map();
async function staticFile(rel) {
  const info = await stat(join(ROOT, rel));
  if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
  const key = `${info.dev}:${info.ino}`;
  const etag = `"${info.size}-${info.mtimeMs}"`;
  const hit = staticCache.get(key);
  if (hit && hit.etag === etag) return hit;
  const body = await readFile(join(ROOT, rel));
  const entry = { etag, body, gzip: gzipSync(body) };
  staticCache.set(key, entry);
  return entry;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/examples") {
      const date = url.searchParams.get("date");
      const payload = date ? await examples.day(date) : await examples.universePayload();
      if (!payload) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unknown sample date" })); return; }
      send(req, res, 200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }, Buffer.from(JSON.stringify(payload)));
      return;
    }
    if (url.pathname === "/api/today") {
      const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : null;
      const body = Buffer.from(JSON.stringify(await today.payload(url.searchParams.get("date"), since)));
      send(req, res, 200, { "content-type": "application/json", "cache-control": "no-store" }, body);
      return;
    }
    // Static files come from this folder only. Dotfiles (like .env.local) are never served.
    // The browser keeps a copy and asks again with the ETag. An unchanged file answers 304 with no body.
    const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^[/\\]+/, "");
    if (rel.split(sep).some((part) => part.startsWith(".") || part === "..")) { res.writeHead(404).end(); return; }
    const file = await staticFile(rel);
    const headers = { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", etag: file.etag, "cache-control": "no-cache", vary: "accept-encoding" };
    if (req.headers["if-none-match"] === file.etag) { res.writeHead(304, headers).end(); return; }
    if (wantsGzip(req)) { res.writeHead(200, { ...headers, "content-encoding": "gzip" }); res.end(file.gzip); }
    else { res.writeHead(200, headers); res.end(file.body); }
  } catch (err) {
    if (err.code === "ENOENT") { res.writeHead(404).end(); return; }
    // A build that has not reached SPY yet answers 202 (accepted, not ready), and the page asks again in a few seconds.
    if (err.building) { res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" }).end(JSON.stringify({ building: true })); return; }
    console.error({ path: url.pathname, err: err.message }, "request failed");
    res.writeHead(502, { "content-type": "application/json" });
    // The client gets a generic message. The details stay in the server log.
    res.end(JSON.stringify({ error: "Market data is unavailable right now" }));
  }
}).listen(PORT, () => console.log(`market-city on http://localhost:${PORT}`));
