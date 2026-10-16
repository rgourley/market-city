// The Massive client and the session builder. today.mjs and examples.mjs both use it.

const BASE = "https://api.massive.com";
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

export function createClient(key) {
  if (!key) throw new Error("Missing MASSIVE_API_KEY");

  async function get(path) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) return res.json();
      const body = await res.text();
      // A 404 is a final answer. The caller decides what to do with a missing ticker.
      if (res.status === 404) return null;
      if (attempt === 3) throw new Error(`Massive ${res.status} on ${path}: ${body.slice(0, 200)}`);
      console.warn({ status: res.status, path, attempt }, "retrying");
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  async function minuteBars(t, date) {
    const j = await get(`/v2/aggs/ticker/${t}/range/1/minute/${date}/${date}?adjusted=true&limit=50000`);
    return (j?.results ?? []).filter((b) => { const m = etTime(b.t).minute; return m >= 0 && m < SLOTS; });
  }

  // The function builds one session for the tickers. With no date, it picks today once today has a trade,
  // and the most recent full session before that. The arrays have 390 slots. Slots with no trade stay null.
  async function buildSession(tickers, date = null) {
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
    await pool(tickers, 10, async (t) => {
      if (!prevClose[t]) return;
      const pct = new Array(SLOTS).fill(null);
      const vol = new Array(SLOTS).fill(0);
      for (const b of await minuteBars(t, session)) {
        const m = etTime(b.t).minute;
        pct[m] = pctOf(b.c, prevClose[t]);
        vol[m] = b.v;
        if (m > lastMinute) lastMinute = m;
      }
      series[t] = { pct, vol };
    });
    return { date: session, prevClose, avgMinuteVol, series, lastMinute };
  }

  // The function returns the market cap of each ticker. A ticker Massive does not know has no entry.
  async function marketCaps(tickers) {
    const caps = {};
    await pool(tickers, 10, async (t) => {
      const j = await get(`/v3/reference/tickers/${t}`);
      if (j?.results?.market_cap) caps[t] = j.results.market_cap;
    });
    return caps;
  }

  return { get, buildSession, marketCaps };
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
