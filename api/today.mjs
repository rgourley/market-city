// The Vercel function for GET /api/today. It does the same job as the server.mjs route.
// The session lives in the Vercel Runtime Cache, so function calls share it.
// The CDN keeps each response for 30 seconds, so all viewers share one function call per query.
// Set MASSIVE_API_KEY in the Vercel project environment variables.
import { getCache, waitUntil } from "@vercel/functions";
import baseUniverse from "../universe.json" with { type: "json" };
import { createToday } from "../lib/today.mjs";
import { isLite, planUniverse, prefixedStore, trackedTickers } from "../lib/plan.mjs";

// The cache client gives each read and write 500 ms by default. A read that times out returns null, the same as a miss,
// and the server then rebuilds from Massive. The stored sessions are large, so the client gets 5 seconds.
process.env.RUNTIME_CACHE_TIMEOUT ??= "5000";
const cache = getCache({ namespace: "market-city" });
// MASSIVE_PLAN=basic turns on lite mode for the free plan.
const lite = isLite(process.env);
const universe = planUniverse(baseUniverse, lite);
const today = createToday({
  key: process.env.MASSIVE_API_KEY,
  tickers: trackedTickers(universe),
  store: prefixedStore({ get: (k) => cache.get(k), set: (k, v, ttl) => cache.set(k, v, { ttl, name: "market-city-session" }) }, lite),
  lite,
  displayDelayMinutes: Number(process.env.DISPLAY_DELAY_MINUTES ?? 15),
  waitUntil,
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
    return Response.json(body, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" } });
  } catch (err) {
    // A build that has not reached SPY yet answers 202 (accepted, not ready), and the page asks again in a few seconds.
    if (err.building) return Response.json({ building: true }, { status: 202, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
    console.error({ path: url.pathname, err: err.message }, "today failed");
    // The client gets a generic message. The details stay in the function log.
    return Response.json({ error: "Market data is unavailable right now" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=10" } });
  }
}
