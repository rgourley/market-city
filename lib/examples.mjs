// The examples module builds the fixed sample days and the market caps from Massive, then keeps them in the store.
// The repo holds only the ticker list and the sample dates (universe.json). No market data is committed.
// The first request builds everything (about 1,050 calls). Later requests read the store.
import { createClient, toDaySeries } from "./massive.mjs";

const TTL_SECONDS = 30 * 24 * 3600;
const LOCK_KEY = "examples-building-until";
const FAIL_KEY = "examples-failed-until";
const BUILD_LOCK_MS = 240_000;
const BUILD_BACKOFF_MS = 120_000;

export function createExamples({ key, universe, store }) {
  const massive = createClient(key);
  const tickers = ["SPY", ...universe.sectors.flatMap((s) => [s.etf, ...s.tickers])];

  async function build() {
    const caps = (await store.get("caps")) ?? await massive.marketCaps(universe.sectors.flatMap((s) => s.tickers));
    await store.set("caps", caps, TTL_SECONDS);
    const days = [];
    for (const ex of universe.examples) {
      let day = await store.get(`day:${ex.date}`);
      if (!day) {
        const s = await massive.buildSession(tickers, ex.date);
        day = { date: ex.date, label: ex.label, series: toDaySeries(s) };
        await store.set(`day:${ex.date}`, day, TTL_SECONDS);
        console.log({ date: ex.date, tickers: Object.keys(day.series).length }, "built example day");
      }
      days.push(day);
    }
    return { sectors: universe.sectors, caps, days };
  }

  // Each day is its own store entry, so no entry comes near the Vercel Runtime Cache limit of 2 MB per item.
  async function cached() {
    const caps = await store.get("caps");
    const days = await Promise.all(universe.examples.map((ex) => store.get(`day:${ex.date}`)));
    return caps && days.every(Boolean) ? { sectors: universe.sectors, caps, days } : null;
  }

  // Concurrent requests in one process share one build. Across processes a lock marker lets one build run at a time.
  // A failed build backs off for BUILD_BACKOFF_MS.
  let pending = null;
  async function payload() {
    const ready = await cached();
    if (ready) return ready;
    pending ??= (async () => {
      const blockedUntil = Math.max((await store.get(FAIL_KEY)) ?? 0, (await store.get(LOCK_KEY)) ?? 0);
      if (blockedUntil > Date.now()) throw new Error("The sample days are building or backing off after a failed build");
      await store.set(LOCK_KEY, Date.now() + BUILD_LOCK_MS, BUILD_LOCK_MS / 1000);
      try {
        return await build();
      } catch (err) {
        await store.set(FAIL_KEY, Date.now() + BUILD_BACKOFF_MS, BUILD_BACKOFF_MS / 1000);
        throw err;
      } finally {
        await store.set(LOCK_KEY, 0, 1);
      }
    })().finally(() => { pending = null; });
    return pending;
  }

  return { payload };
}
