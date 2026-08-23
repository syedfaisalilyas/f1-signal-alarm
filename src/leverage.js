// Max leverage per futures symbol, from Binance's public risk-bracket feed.
// The signed /fapi/v1/leverageBracket endpoint needs an API key; this one doesn't.

const URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets';
const TTL = 12 * 60 * 60 * 1000;

let cache = new Map();
let at = 0;
let inflight = null;

async function load() {
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error('brackets ' + res.status);
  const j = await res.json();
  const map = new Map();
  for (const s of j.data?.brackets || []) {
    const lev = Math.max(...s.riskBrackets.map(r => r.maxOpenPosLeverage || 0));
    if (lev > 0) map.set(s.symbol, lev);
  }
  if (!map.size) throw new Error('brackets empty');
  cache = map;
  at = Date.now();
  return cache;
}

export async function refresh() {
  if (cache.size && Date.now() - at < TTL) return cache;
  if (inflight) return inflight;
  inflight = load().catch(e => { console.log('[leverage] refresh failed:', e.message); return cache; })
    .finally(() => { inflight = null; });
  return inflight;
}

// Synchronous lookup for the hot path. Spot has no leverage, so undefined.
export function maxLev(market, symbol) {
  if (market !== 'futures') return null;
  return cache.get(symbol) ?? null;
}

export const loaded = () => cache.size;
