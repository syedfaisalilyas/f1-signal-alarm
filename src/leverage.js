// Max leverage per symbol, from MEXC's public contract list.
//
// Binance's keyless bracket feed lags badly for new listings (it still reported
// TUTUSDT at 10x months after it moved to 100x). MEXC publishes live maxLeverage
// for every contract with no key at all, so leverage comes from there. Market
// data still comes from Binance — this is only the leverage number.

const MEXC = 'https://contract.mexc.com/api/v1/contract/detail';
const TTL = 12 * 60 * 60 * 1000;

let cache = new Map();
let at = 0;
let inflight = null;
let overrides = new Map();

export function setOverrides(map = {}) {
  overrides = new Map(Object.entries(map).map(([k, v]) => [k.toUpperCase(), Number(v)]).filter(([, v]) => v > 0));
  return overrides.size;
}

// BTCUSDT -> BTC_USDT.  Binance sizes some contracts as 1000PEPEUSDT / 1MBABYDOGE;
// the multiplier doesn't change the leverage, so strip it before matching.
export function toMexcSymbol(symbol) {
  const m = symbol.toUpperCase().match(/^(?:1000000|1000|1M|1B)?(.+?)(USDT|USDC|USD)$/);
  return m ? `${m[1]}_${m[2]}` : null;
}

async function load() {
  const res = await fetch(MEXC, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`mexc ${res.status}`);
  const j = await res.json();
  const map = new Map();
  for (const c of j.data || []) {
    const lev = Number(c.maxLeverage);
    if (lev > 0) map.set(c.symbol, lev);
  }
  if (!map.size) throw new Error('mexc returned no contracts');
  cache = map;
  at = Date.now();
  return cache;
}

export async function refresh() {
  if (cache.size && Date.now() - at < TTL) return cache;
  if (inflight) return inflight;
  inflight = load().catch(e => { console.log('[leverage] mexc refresh failed:', e.message); return cache; })
    .finally(() => { inflight = null; });
  return inflight;
}

export function maxLev(market, symbol) {
  if (market === 'forex') return null;
  const o = overrides.get(symbol.toUpperCase());
  if (o) return o;
  const m = toMexcSymbol(symbol);
  return (m && cache.get(m)) ?? null;
}

export function levSource(symbol) {
  return overrides.has(symbol.toUpperCase()) ? 'manual override' : 'mexc';
}

export const loaded = () => cache.size;
export const sourceName = () => 'MEXC contract list';
