// Lite mode runs the city on the free Stocks Basic plan. Set MASSIVE_PLAN=basic to turn it on.
// The free plan allows 5 calls a minute, has no snapshots and has end-of-day data only. So lite mode:
//   tracks only SPY and the 11 sector ETFs, one tower per sector,
//   spaces requests 12.5 seconds apart,
//   has no live mode and shows the last full session.

export const isLite = (env) => String(env.MASSIVE_PLAN ?? "").toLowerCase() === "basic";

// The function returns the universe for the plan. Lite mode drops the stocks and keeps each sector's ETF.
export function planUniverse(universe, lite) {
  return lite ? { ...universe, lite: true, sectors: universe.sectors.map((s) => ({ ...s, tickers: [] })) } : { ...universe, lite: false };
}

// SPY comes first, then the sector ETFs, then the stocks. A build fills in that order, so the city appears early.
export const trackedTickers = (universe) => ["SPY", ...universe.sectors.map((s) => s.etf), ...universe.sectors.flatMap((s) => s.tickers)];

// 12.5 seconds between requests keeps lite mode under 5 calls a minute.
export const clientOptions = (lite) => (lite ? { minIntervalMs: 12_500 } : {});

// Store keys carry the mode, so a lite build and a full build never share an entry.
export function prefixedStore(store, lite) {
  const p = lite ? "lite:" : "";
  return { get: (k) => store.get(p + k), set: (k, v, ttl) => store.set(p + k, v, ttl) };
}
