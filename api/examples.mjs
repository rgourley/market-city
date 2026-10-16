// The Vercel function for /api/examples: the sector list, the market caps and the sample days.
// The data lives in the Vercel Runtime Cache for a year. The CDN keeps each response for a day.
import { getCache } from "@vercel/functions";
import universe from "../universe.json" with { type: "json" };
import { createExamples } from "../lib/examples.mjs";

const cache = getCache({ namespace: "market-city" });
const examples = createExamples({
  key: process.env.MASSIVE_API_KEY,
  universe,
  store: { get: (k) => cache.get(k), set: (k, v, ttl) => cache.set(k, v, { ttl, name: "market-city-examples" }) },
});

// GET /api/examples gives the sectors, caps and sample dates. GET /api/examples?date=YYYY-MM-DD gives one sample day.
export async function GET(request) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((k) => k !== "date")) {
    return Response.json({ error: "Unknown query parameter" }, { status: 400, headers: { "Cache-Control": "public, s-maxage=3600" } });
  }
  try {
    const date = url.searchParams.get("date");
    const body = date ? await examples.day(date) : await examples.universePayload();
    if (!body) return Response.json({ error: "Unknown sample date" }, { status: 404, headers: { "Cache-Control": "public, s-maxage=3600" } });
    return Response.json(body, { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } });
  } catch (err) {
    console.error({ err: err.message }, "examples failed");
    // The client gets a generic message. The details stay in the function log.
    return Response.json({ error: "Market data is unavailable right now" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=10" } });
  }
}
