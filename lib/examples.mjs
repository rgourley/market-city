// The examples module serves the sectors, the market caps and the fixed sample days, all built from Massive.
// The repo holds only the ticker list and the sample dates (universe.json). No market data is committed.
// The market caps build on the first request. Each sample day builds the first time someone picks it.
// Everything stays in the store for a year, because past days never change.
import { createClient, toDaySeries } from "./massive.mjs";
import { clientOptions, trackedTickers } from "./plan.mjs";

const TTL_SECONDS = 365 * 24 * 3600;
const BUILD_LOCK_MS = 300_000; // A lite build at 12.5 s a call takes about 3 minutes.
const BUILD_BACKOFF_MS = 120_000;

// universe comes from planUniverse. In lite mode it has no stocks, and the ETF towers are sized by dollar volume.
export function createExamples({ key, universe, store }) {
  const massive = createClient(key, clientOptions(universe.lite));
  const tickers = trackedTickers(universe);
  const dates = new Set(universe.examples.map((e) => e.date));

  // Concurrent requests in one process share one build per key. Across processes a lock marker in the store
  // lets one build run at a time. A failed build backs off for BUILD_BACKOFF_MS.
  const pending = new Map();
  function cachedBuild(storeKey, build) {
    if (pending.has(storeKey)) return pending.get(storeKey);
    const run = (async () => {
      const hit = await store.get(storeKey);
      if (hit) return hit;
      const lockKey = `${storeKey}:building-until`, failKey = `${storeKey}:failed-until`;
      const blockedUntil = Math.max((await store.get(failKey)) ?? 0, (await store.get(lockKey)) ?? 0);
      if (blockedUntil > Date.now()) throw new Error(`${storeKey} is building or backing off after a failed build`);
      await store.set(lockKey, Date.now() + BUILD_LOCK_MS, BUILD_LOCK_MS / 1000);
      try {
        const value = await build();
        await store.set(storeKey, value, TTL_SECONDS);
        return value;
      } catch (err) {
        await store.set(failKey, Date.now() + BUILD_BACKOFF_MS, BUILD_BACKOFF_MS / 1000);
        throw err;
      } finally {
        await store.set(lockKey, 0, 1);
      }
    })().finally(() => pending.delete(storeKey));
    pending.set(storeKey, run);
    return run;
  }

  // The universe payload: the sectors, the market caps and the list of sample dates. No day data.
  async function universePayload() {
    const caps = await cachedBuild("caps", () => (universe.lite
      ? massive.dollarVolumes(universe.sectors.map((s) => s.etf))
      : massive.marketCaps(universe.sectors.flatMap((s) => s.tickers))));
    return { sectors: universe.sectors, caps, examples: universe.examples, lite: universe.lite };
  }

  // One sample day. Only the dates in universe.json are allowed.
  async function day(date) {
    if (!dates.has(date)) return null;
    const ex = universe.examples.find((e) => e.date === date);
    return cachedBuild(`day:${date}`, async () => {
      const s = await massive.buildSession(tickers, date);
      console.log({ date, tickers: Object.keys(s.series).length }, "built example day");
      return { date, label: ex.label, series: toDaySeries(s) };
    });
  }

  return { universePayload, day };
}
