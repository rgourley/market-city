// The today module builds the session the page shows and keeps it fresh from Massive.
// It does not know how it is hosted. The host passes a store, and the module keeps its state there:
//   server.mjs passes an in-memory store (one long-running process).
//   api/today.mjs passes the Vercel Runtime Cache (many short function calls).
// The module refreshes on demand: a request that finds the data older than REFRESH_MS refreshes it first.
import { createClient, etTime, pctOf, SLOTS, toDaySeries } from "./massive.mjs";
import { clientOptions } from "./plan.mjs";

const REFRESH_MS = 60_000; // The city runs on minute bars, so one refresh a minute is enough.
const STORE_KEY = "session";
const LOCK_KEY = "building-until";
const FAIL_KEY = "failed-until";
const STORE_TTL_SECONDS = 26 * 3600;
const BUILD_LOCK_MS = 300_000; // A lite build at 12.5 s a call takes about 3 minutes.
const BUILD_BACKOFF_MS = 60_000;
const STATUS_TTL_MS = 5 * 60_000;

// Starter and Developer plans get 15-minute delayed data. The age of the newest minute bar in the snapshot shows the delay.
// A delay under 5 minutes counts as real time. A longer one rounds to the nearest 5 minutes.
export function snapshotDelayMinutes(snapTickers, now) {
  const newest = Math.max(0, ...snapTickers.map((t) => t.min?.t ?? 0));
  const lag = newest ? (now - newest) / 60_000 : 0;
  return lag >= 5 ? Math.round(lag / 5) * 5 : 0;
}

// The function says whether the clock rules out an open market: weekends, and before 09:25 or after 16:05 ET.
// Holidays are not in the clock, so the market status call still covers them.
function surelyClosed(ms) {
  const { minute } = etTime(ms);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(ms));
  return weekday === "Sat" || weekday === "Sun" || minute < -5 || minute > SLOTS + 5;
}

// The function returns the today service. tickers is the list to track. store keeps the session between requests.
// displayDelayMinutes holds back the newest minutes of today. The default is 15, the usual level for showing
// market data to the public. A host whose plan allows real-time display sets DISPLAY_DELAY_MINUTES=0.
// lite (the free plan) has no snapshots, so the session is built once a day and never refreshed.
export function createToday({ key, tickers, store, displayDelayMinutes = 15, lite = false, waitUntil = null }) {
  const massive = createClient(key, clientOptions(lite));

  // The session is today's session once it has a trade. Before the open, and on days with no session,
  // it is the most recent full session. The build saves its progress after each ticker, at most every 3 seconds,
  // so the page can show the city while the rest loads.
  async function build() {
    const { date: etToday } = etTime(Date.now());
    // The build gets the market status first, so the page stays live while a build runs during market hours.
    // If the status call fails, the build continues and the page shows a replay until the first refresh.
    const status = { market: "unknown", statusAt: 0 };
    try {
      status.market = lite ? "closed" : await marketStatus(status);
    } catch (err) {
      console.error({ err: err.message }, "market status failed before the build");
    }
    let savedAt = 0;
    const save = async (partial, building) => {
      await store.set(STORE_KEY, {
        ...partial, builtOn: etToday, building, total: tickers.length,
        market: status.market, statusAt: status.statusAt, checkedAt: building ? Date.now() : 0, asOf: Date.now(),
      }, STORE_TTL_SECONDS);
    };
    const s = await massive.buildSession(tickers, null, async (partial) => {
      if (Date.now() - savedAt < 3000) return;
      savedAt = Date.now();
      await save(partial, true);
    });
    await save(s, false);
    console.log({ session: s.date, builtOn: etToday, tickers: Object.keys(s.series).length, lastMinute: s.lastMinute }, "built session");
    return store.get(STORE_KEY);
  }

  // The market status is cached, and the clock answers outside market hours with no call.
  // An open market is checked every 5 minutes. A closed one is checked every minute, so live mode starts soon after the open.
  async function marketStatus(s) {
    const now = Date.now();
    if (surelyClosed(now)) return "closed";
    const ttl = s.market === "open" ? STATUS_TTL_MS : 60_000;
    if (s.statusAt && now - s.statusAt < ttl) return s.market;
    const status = await massive.get("/v1/marketstatus/now");
    s.statusAt = now;
    return status.market;
  }

  // One snapshot call updates the current minute for every ticker.
  async function refresh(s) {
    if (lite) { s.market = "closed"; s.checkedAt = Date.now(); return s; }
    s.market = await marketStatus(s);
    s.checkedAt = Date.now();
    if (s.market !== "open") return s;
    // The market opened while the store holds an older session. Marking it stale makes the next request build today under the lock.
    if (s.date !== etTime(Date.now()).date) return { ...s, builtOn: null };
    const snap = await massive.get(`/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(",")}`);
    s.delayMinutes = snapshotDelayMinutes(snap?.tickers ?? [], Date.now());
    for (const t of snap?.tickers ?? []) {
      const row = s.series[t.ticker], prev = s.prevClose[t.ticker];
      if (!row || !prev || !t.min?.t || !(t.min.c > 0)) continue;
      const { date, minute } = etTime(t.min.t);
      if (date !== s.date || minute < 0 || minute >= SLOTS) continue;
      row.pct[minute] = pctOf(t.min.c, prev);
      row.vol[minute] = t.min.v;
      if (minute > s.lastMinute) s.lastMinute = minute;
    }
    s.asOf = Date.now();
    return s;
  }

  // A build runs in the background. The request that starts it, and every request during it, gets the session so far.
  // A lock marker in the store lets one build run at a time across processes (Vercel instances).
  // A failed build backs off for BUILD_BACKOFF_MS. A failed refresh keeps the last good data and waits a full REFRESH_MS.
  // waitUntil keeps a Vercel function alive after it responds, so the background build can finish.
  let building = null;
  function startBuild() {
    building ??= (async () => {
      await store.set(LOCK_KEY, Date.now() + BUILD_LOCK_MS, BUILD_LOCK_MS / 1000);
      try {
        await refreshAndSave(await build());
      } catch (err) {
        console.error({ err: err.message }, "build failed");
        await store.set(FAIL_KEY, Date.now() + BUILD_BACKOFF_MS, BUILD_BACKOFF_MS / 1000);
      } finally {
        await store.set(LOCK_KEY, 0, 1);
      }
    })().finally(() => { building = null; });
    waitUntil?.(building);
    return building;
  }

  async function refreshAndSave(s) {
    try {
      s = await refresh(s);
    } catch (err) {
      console.error({ err: err.message }, "refresh failed; keeping the last good data");
      s.checkedAt = Date.now();
    }
    await store.set(STORE_KEY, s, STORE_TTL_SECONDS);
    return s;
  }

  let pending = null;
  async function current() {
    const s = await store.get(STORE_KEY);
    const { date: etToday } = etTime(Date.now());
    const stale = !s || s.builtOn !== etToday;
    if (stale || s.building) {
      const blockedUntil = Math.max((await store.get(FAIL_KEY)) ?? 0, (await store.get(LOCK_KEY)) ?? 0);
      // No build is running here or elsewhere, so this request starts one.
      if (blockedUntil <= Date.now()) startBuild();
      // The page needs SPY for the sky and the weather, so a session without it is not sent.
      if (s?.series?.SPY) return s;
      throw Object.assign(new Error("The session is building"), { building: true });
    }
    if (Date.now() - s.checkedAt < REFRESH_MS) return s;
    pending ??= refreshAndSave(s).finally(() => { pending = null; });
    return pending;
  }

  // The payload has the same shape as a sample day.
  // With a matching date and a since minute, the payload holds only the minutes from since to lastMinute.
  // The minute at since comes again, because the snapshot can still change the newest minute.
  async function payload(date, since) {
    const fresh = await current();
    const isToday = fresh.date === etTime(Date.now()).date;
    // Today's newest minutes stay back by the display delay. A past session shows in full.
    const cutoff = isToday && displayDelayMinutes > 0 ? etTime(Date.now() - displayDelayMinutes * 60_000).minute : SLOTS;
    const s = { ...fresh, lastMinute: Math.min(fresh.lastMinute, cutoff) };
    // During a build the payload is always full, because new tickers arrive with their whole day.
    const delta = !s.building && date === s.date && Number.isInteger(since) && since >= 0;
    const from = delta ? Math.min(since, Math.max(0, s.lastMinute)) : 0;
    const end = delta ? s.lastMinute + 1 : SLOTS;
    return {
      date: s.date, label: isToday ? "Today" : "Last session", live: isToday && s.market === "open",
      building: Boolean(s.building), progress: s.building ? { done: Object.keys(s.series).length, total: s.total } : null, lite,
      lastMinute: s.lastMinute, asOf: s.asOf, delayMinutes: Math.max(s.delayMinutes ?? 0, isToday ? displayDelayMinutes : 0), ...(delta ? { from } : {}), series: toDaySeries(s, from, end),
    };
  }

  return { payload };
}
