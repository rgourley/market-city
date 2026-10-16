// The Vercel function for GET /api/examples: the sample days, the sector list and the market caps.
// The data lives in the Vercel Runtime Cache for 30 days. The CDN keeps each response for a day.
import { getCache } from "@vercel/functions";
import universe from "../universe.json" with { type: "json" };
import { createExamples } from "../lib/examples.mjs";

const cache = getCache({ namespace: "market-city" });
const examples = createExamples({
  key: process.env.MASSIVE_API_KEY,
  universe,
  store: { get: (k) => cache.get(k), set: (k, v, ttl) => cache.set(k, v, { ttl, name: "market-city-examples" }) },
});

export async function GET(request) {
  if (new URL(request.url).search) {
    return Response.json({ error: "Unknown query parameter" }, { status: 400, headers: { "Cache-Control": "public, s-maxage=3600" } });
  }
  try {
    return Response.json(await examples.payload(), { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } });
  } catch (err) {
    console.error({ err: err.message }, "examples failed");
    // The client gets a generic message. The details stay in the function log.
    return Response.json({ error: "Market data is unavailable right now" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=10" } });
  }
}
