// Max leverage per futures symbol, from Binance's public risk-bracket feed.
// The signed /fapi/v1/leverageBracket endpoint needs an API key; this one doesn't.

import crypto from 'crypto';

const URL = 'https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets';
const SIGNED = 'https://fapi.binance.com/fapi/v1/leverageBracket';
const TTL = 12 * 60 * 60 * 1000;

let cache = new Map();
let at = 0;
let inflight = null;
let source = 'none';
let overrides = new Map();

// The public bracket feed lags for recently listed coins — TUTUSDT still
// reported 10x months after Binance raised it. Set overrides, or supply a
// read-only API key to read the live brackets directly.
export function setOverrides(map = {}) {
  overrides = new Map(Object.entries(map).map(([k, v]) => [k.toUpperCase(), Number(v)]).filter(([, v]) => v > 0));
  return overrides.size;
}

async function loadSigned() {
  const key = process.env.BINANCE_API_KEY, secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) return null;
  const qs = `timestamp=${Date.now()}&recvWindow=10000`;
  const sig = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const res = await fetch(`${SIGNED}?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': key }, signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`leverageBracket ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  const map = new Map();
  for (const s of j) {
    const lev = Math.max(...s.brackets.map(b => b.initialLeverage || 0));
    if (lev > 0) map.set(s.symbol, lev);
  }
  return map.size ? map : null;
}

async function loadPublic() {
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
  return map;
}

async function load() {
  let map = null;
  try { map = await loadSigned(); if (map) source = 'api-key (exact)'; }
  catch (e) { console.log('[leverage] signed lookup failed:', e.message); }
  if (!map) { map = await loadPublic(); source = 'public feed (may lag new listings)'; }
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
  return overrides.get(symbol) ?? cache.get(symbol) ?? null;
}

export function levSource(symbol) {
  if (overrides.has(symbol)) return 'manual override';
  return source;
}

export const loaded = () => cache.size;
export const sourceName = () => source;
