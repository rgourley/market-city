// The Massive client and the session builder. today.mjs and examples.mjs both use it.

const BASE = "https://api.massive.com";
// The User-Agent names the app, so Massive can see what the traffic is.
const USER_AGENT = "market-city (+https://github.com/rgourley/market-city)";
export const SLOTS = 390; // The regular session has 390 one-minute slots from 09:30 to 16:00 ET.

// The function returns the ET date and the session minute (0..389, or outside that range) for a millisecond timestamp.
export function etTime(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) - 570 };
}

export const pctOf = (price, prev) => Math.round((price / prev - 1) * 10000) / 100;

export function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// The function returns a store for a long-running process. It keeps values in memory.
export function memoryStore() {
  const map = new Map();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); } };
}

// minIntervalMs spaces the start of each request. Lite mode uses it to stay under the free plan's rate limit.
export function createClient(key, { minIntervalMs = 0 } = {}) {
  if (!key) throw new Error("Missing MASSIVE_API_KEY");

  let nextSlot = 0;
  async function waitTurn() {
    if (!minIntervalMs) return;
    const at = Math.max(Date.now(), nextSlot);
    nextSlot = at + minIntervalMs;
    if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
  }

  async function get(path) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitTurn();
      const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT } });
      if (res.ok) return res.json();
      const body = await res.text();
      // A 404 is a final answer. The caller decides what to do with a missing ticker.
      if (res.status === 404) return null;
      if (attempt === 3) throw new Error(`Massive ${res.status} on ${path}: ${body.slice(0, 200)}`);
      // A 429 waits as long as Retry-After says. Other errors wait 1 s, then 2 s.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = res.status === 429 && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * attempt;
      console.warn({ status: res.status, path, attempt, waitMs }, "retrying");
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  async function minuteBars(t, date) {
    const j = await get(`/v2/aggs/ticker/${t}/range/1/minute/${date}/${date}?adjusted=true&limit=50000`);
    return (j?.results ?? []).filter((b) => { const m = etTime(b.t).minute; return m >= 0 && m < SLOTS; });
  }

  // The function builds one session for the tickers. With no date, it picks today once today has a trade,
  // and the most recent full session before that. The arrays have 390 slots. Slots with no trade stay null.
  // onProgress, when given, receives the session so far after each ticker loads.
  async function buildSession(tickers, date = null, onProgress = null) {
    const { date: etToday } = etTime(Date.now());
    const end = date ?? etToday;
    // The SPY daily bars give the session calendar and the 20-session volume average.
    const spyDaily = (await get(`/v2/aggs/ticker/SPY/range/1/day/${shiftDate(end, -45)}/${end}?adjusted=true&limit=60`))?.results ?? [];
    const dayOf = (b) => etTime(b.t + 12 * 3600_000).date;
    let session = date;
    if (!session) {
      const todayTraded = (await minuteBars("SPY", etToday)).length > 0;
      session = todayTraded ? etToday : spyDaily.map(dayOf).filter((d) => d < etToday).pop();
    }
    const prevSession = spyDaily.map(dayOf).filter((d) => d < session).pop();
    if (!session || !prevSession) throw new Error(`No session found for ${date ?? etToday}`);

    // One grouped call gives every ticker's close for the session before.
    const grouped = await get(`/v2/aggs/grouped/locale/us/market/stocks/${prevSession}?adjusted=true`);
    const closes = Object.fromEntries((grouped?.results ?? []).map((b) => [b.T, b.c]));
    const prevClose = Object.fromEntries(tickers.filter((t) => closes[t] > 0).map((t) => [t, closes[t]]));

    const prior20 = spyDaily.filter((b) => dayOf(b) < session).slice(-20);
    const avgMinuteVol = prior20.reduce((s, b) => s + b.v, 0) / prior20.length / SLOTS;

    const series = {};
    let lastMinute = -1;
    // Four requests at a time keep the build a steady trickle instead of a burst.
    await pool(tickers, 4, async (t) => {
      if (!prevClose[t]) return;
      const pct = new Array(SLOTS).fill(null);
      // Only SPY keeps its volume. The page uses SPY volume for traffic, and the stored session stays half the size.
      const vol = t === "SPY" ? new Array(SLOTS).fill(0) : null;
      for (const b of await minuteBars(t, session)) {
        const m = etTime(b.t).minute;
        pct[m] = pctOf(b.c, prevClose[t]);
        if (vol) vol[m] = b.v;
        if (m > lastMinute) lastMinute = m;
      }
      series[t] = vol ? { pct, vol } : { pct };
      await onProgress?.({ date: session, prevClose, avgMinuteVol, series, lastMinute });
    });
    return { date: session, prevClose, avgMinuteVol, series, lastMinute };
  }

  // The function returns the market cap of each ticker. A ticker Massive does not know has no entry.
  async function marketCaps(tickers) {
    const caps = {};
    // Four requests at a time keep the build a steady trickle instead of a burst.
    await pool(tickers, 4, async (t) => {
      const j = await get(`/v3/reference/tickers/${t}`);
      if (j?.results?.market_cap) caps[t] = j.results.market_cap;
    });
    return caps;
  }

  // The function returns each ticker's dollar volume (shares times average price) on the most recent session.
  // Lite mode sizes the ETF towers with it, because ETFs have no market cap. It costs 2 calls.
  async function dollarVolumes(tickers) {
    const { date: etToday } = etTime(Date.now());
    const spyDaily = (await get(`/v2/aggs/ticker/SPY/range/1/day/${shiftDate(etToday, -10)}/${shiftDate(etToday, -1)}?adjusted=true&limit=20`))?.results ?? [];
    const last = spyDaily.at(-1);
    if (!last) throw new Error(`No session found before ${etToday}`);
    const grouped = await get(`/v2/aggs/grouped/locale/us/market/stocks/${etTime(last.t + 12 * 3600_000).date}?adjusted=true`);
    const want = new Set(tickers);
    return Object.fromEntries((grouped?.results ?? []).filter((b) => want.has(b.T) && b.v > 0).map((b) => [b.T, b.v * (b.vw ?? b.c)]));
  }

  return { get, buildSession, marketCaps, dollarVolumes };
}

// The function turns a built session into the page's day shape. Minutes before the first trade use the first price,
// and minutes with no trade repeat the last price. Slots after lastMinute stay null. SPY also gets volRatio.
export function toDaySeries(s, from = 0, end = SLOTS) {
  const series = {};
  for (const [t, row] of Object.entries(s.series)) {
    const first = row.pct.find((v) => v !== null);
    if (first === undefined) continue;
    let last = first;
    const pct = row.pct.map((v, m) => (m > s.lastMinute ? null : (last = v ?? last)));
    series[t] = { pct: pct.slice(from, end) };
    if (t === "SPY") {
      const volRatio = row.vol.map((v, m) => (m > s.lastMinute ? null : Math.round((v / s.avgMinuteVol) * 100) / 100));
      series[t].volRatio = volRatio.slice(from, end);
    }
  }
  return series;
}
