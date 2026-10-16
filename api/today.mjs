// The Vercel function for GET /api/today. It does the same job as the server.mjs route.
// The session lives in the Vercel Runtime Cache, so function calls share it.
// The CDN keeps each response for 25 seconds, so all viewers share one function call per query.
// Set MASSIVE_API_KEY in the Vercel project environment variables.
import { getCache } from "@vercel/functions";
import universe from "../universe.json" with { type: "json" };
import { createToday } from "../lib/today.mjs";

const cache = getCache({ namespace: "market-city" });
const today = createToday({
  key: process.env.MASSIVE_API_KEY,
  tickers: ["SPY", ...universe.sectors.flatMap((s) => [s.etf, ...s.tickers])],
  store: { get: (k) => cache.get(k), set: (k, v, ttl) => cache.set(k, v, { ttl, name: "market-city-session" }) },
});

// Only date and since are allowed. Other parameters would make new CDN cache keys, so they are rejected.
const ALLOWED = new Set(["date", "since"]);

export async function GET(request) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((k) => !ALLOWED.has(k))) {
    return Response.json({ error: "Unknown query parameter" }, { status: 400, headers: { "Cache-Control": "public, s-maxage=3600" } });
  }
  const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : null;
  try {
    const body = await today.payload(url.searchParams.get("date"), since);
    return Response.json(body, { headers: { "Cache-Control": "public, s-maxage=25, stale-while-revalidate=30" } });
  } catch (err) {
    console.error({ path: url.pathname, err: err.message }, "today failed");
    // The client gets a generic message. The details stay in the function log.
    return Response.json({ error: "Market data is unavailable right now" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=10" } });
  }
}
