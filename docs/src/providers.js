// Market data. Crypto = Binance (no API key). Forex = Twelve Data (free key).

import { SPOT_MIRROR, isGeoBlocked, isRateLimited, shouldFallBack, mexcCandles, mexcTicker, mexcPerps, mexcFactor } from './geofeed.js';

const SPOT = 'https://api.binance.com/api/v3';
const FUT = 'https://fapi.binance.com/fapi/v1';
const TD = 'https://api.twelvedata.com';

// Binance answers 451 from restricted regions rather than failing outright, so
// the first blocked call switches the source for the rest of the process.
let spotBase = SPOT;
let futuresViaMexc = false;

function fellBack(what, to, why = '451') {
  console.warn(`[providers] Binance returned ${why} for ${what} — using ${to}`);
}

export const feedSources = () => ({
  spot: spotBase === SPOT ? 'binance' : 'binance-vision',
  futures: futuresViaMexc ? 'mexc' : 'binance'
});

export const WS_URL = {
  spot: 'wss://stream.binance.com:9443/stream',
  futures: 'wss://fstream.binance.com/stream'
};

const cache = { symbols: { spot: null, futures: null, forex: null }, at: { spot: 0, futures: 0, forex: 0 } };
const TTL = 12 * 60 * 60 * 1000;

async function jget(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'f1-alarm/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url.split('?')[0]}`);
  return res.json();
}

export async function listSymbols(market) {
  if (cache.symbols[market] && Date.now() - cache.at[market] < TTL) return cache.symbols[market];
  let out = [];
  if (market === 'futures' && futuresViaMexc) {
    out = await mexcPerps();
    cache.symbols[market] = out;
    cache.at[market] = Date.now();
    return out;
  }
  if (market === 'spot' || market === 'futures') {
    const base = market === 'spot' ? spotBase : FUT;
    let info;
    try {
      info = await jget(`${base}/exchangeInfo`);
    } catch (e) {
      if (!shouldFallBack(e)) throw e;
      if (market === 'futures') { futuresViaMexc = true; fellBack('perp symbols', 'MEXC'); return listSymbols(market); }
      if (spotBase === SPOT) { spotBase = SPOT_MIRROR; fellBack('spot symbols', 'data-api.binance.vision'); return listSymbols(market); }
      throw e;
    }
    out = info.symbols
      .filter(s => s.status === 'TRADING' && (market === 'futures' ? s.contractType === 'PERPETUAL' : true))
      .map(s => ({
        market, symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset,
        label: `${s.baseAsset}/${s.quoteAsset}`,
        tick: Number(s.filters.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || 0)
      }));
  } else if (market === 'forex') {
    if (!process.env.TWELVEDATA_KEY) return [];
    const d = await jget(`${TD}/forex_pairs`);
    out = (d.data || []).map(p => ({
      market: 'forex', symbol: p.symbol, base: p.currency_base, quote: p.currency_quote,
      label: p.symbol, tick: 0
    }));
  }
  cache.symbols[market] = out;
  cache.at[market] = Date.now();
  return out;
}

export async function searchSymbols(q, markets = ['spot', 'futures', 'forex']) {
  const term = (q || '').trim().toUpperCase();
  const lists = await Promise.all(markets.map(m => listSymbols(m).catch(() => [])));
  const all = lists.flat();
  if (!term) return all.filter(s => s.quote === 'USDT').slice(0, 40);
  const scored = [];
  for (const s of all) {
    const sym = s.symbol.toUpperCase(), base = (s.base || '').toUpperCase();
    let score = -1;
    if (sym === term || base === term) score = 0;
    else if (base.startsWith(term)) score = 1;
    else if (sym.startsWith(term)) score = 2;
    else if (sym.includes(term)) score = 3;
    if (score >= 0) {
      if (s.quote === 'USDT') score -= 0.5;              // USDT pairs first
      if (s.market === 'spot') score -= 0.2;
      scored.push({ ...s, score });
    }
  }
  return scored.sort((a, b) => a.score - b.score || a.symbol.length - b.symbol.length).slice(0, 60);
}

const TD_INTERVAL = { '1m': '1min', '3m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h' };

export async function fetchCandles(market, symbol, interval, limit = 500) {
  if (market === 'forex') return fetchForex(symbol, interval, limit);
  if (market === 'futures' && futuresViaMexc) return perpCandles(symbol, interval, limit);
  const base = market === 'futures' ? FUT : spotBase;
  try {
    const raw = await jget(`${base}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return raw.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
      closeTime: k[6], closed: k[6] < Date.now()
    }));
  } catch (e) {
    if (!shouldFallBack(e)) throw e;
    if (market === 'futures') {
      futuresViaMexc = true;
      fellBack('perp candles', 'MEXC', isRateLimited(e) ? '418/429 (rate limit)' : '451');
      return perpCandles(symbol, interval, limit);
    }
    if (spotBase === SPOT) {
      spotBase = SPOT_MIRROR;
      fellBack('spot candles', 'data-api.binance.vision', isRateLimited(e) ? '418/429 (rate limit)' : '451');
      return fetchCandles(market, symbol, interval, limit);
    }
    throw e;
  }
}

// MEXC has no 3m contract candle, so it arrives as 1m and gets rolled up here.
async function perpCandles(symbol, interval, limit) {
  const factor = mexcFactor(interval);
  const bars = await mexcCandles(symbol, interval, limit);
  return factor > 1 ? aggregate(bars, factor) : bars;
}

async function fetchForex(symbol, interval, limit) {
  const key = process.env.TWELVEDATA_KEY;
  if (!key) throw new Error('TWELVEDATA_KEY not set — forex needs a free key from twelvedata.com');
  const native = TD_INTERVAL[interval] || '1min';
  const need = interval === '3m' ? limit * 3 : limit;
  const d = await jget(`${TD}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${native}&outputsize=${Math.min(need, 5000)}&apikey=${key}&format=JSON`);
  if (d.status === 'error') throw new Error(d.message || 'twelvedata error');
  const bars = (d.values || []).map(v => ({
    t: new Date(v.datetime + 'Z').getTime(),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0)
  })).reverse();
  const ms = native === '1min' ? 60000 : native === '5min' ? 300000 : native === '15min' ? 900000 : native === '30min' ? 1800000 : 3600000;
  bars.forEach(b => { b.closeTime = b.t + ms - 1; b.closed = b.closeTime < Date.now(); });
  return interval === '3m' ? aggregate(bars, 3) : bars;
}

// Roll N smaller candles into one (used to build 3m from 1m for providers without it)
export function aggregate(bars, n) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const bucket = Math.floor(b.t / (60000 * n)) * 60000 * n;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l);
      last.c = b.c; last.v += b.v; last.closeTime = bucket + 60000 * n - 1;
    } else {
      out.push({ t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, closeTime: bucket + 60000 * n - 1 });
    }
  }
  out.forEach(b => { b.closed = b.closeTime < Date.now(); });
  return out;
}

// Binance caps klines at 1500 per call. Page backwards for deeper history so
// the trade log can go past what the live window holds.
export async function fetchCandlesDeep(market, symbol, interval, bars = 3000) {
  if (market === 'forex') return fetchCandles(market, symbol, interval, Math.min(bars, 5000));
  // The mirror and MEXC both cap a single response well below Binance's paging,
  // so a blocked region just gets the shallower window instead of nothing.
  if (market === 'futures' && futuresViaMexc) return fetchCandles(market, symbol, interval, Math.min(bars, 2000));
  const base = market === 'futures' ? FUT : spotBase;
  const out = [];
  let endTime = Date.now();
  for (let page = 0; page < 6 && out.length < bars; page++) {
    const raw = await jget(`${base}/klines?symbol=${symbol}&interval=${interval}&limit=1500&endTime=${endTime}`);
    if (!raw.length) break;
    const chunk = raw.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
      closeTime: k[6], closed: k[6] < Date.now()
    }));
    out.unshift(...chunk);
    if (raw.length < 1500) break;
    endTime = chunk[0].t - 1;
  }
  // de-dup by open time, oldest first
  const seen = new Set();
  return out.filter(b => (seen.has(b.t) ? false : seen.add(b.t))).sort((a, b) => a.t - b.t);
}

export async function ticker24h(market, symbol) {
  if (market === 'futures' && futuresViaMexc) return mexcTicker(symbol);
  const base = market === 'futures' ? FUT : spotBase;
  try {
    const d = await jget(`${base}/ticker/24hr?symbol=${symbol}`);
    return { price: +d.lastPrice, changePct: +d.priceChangePercent, volume: +d.quoteVolume };
  } catch (e) {
    if (!shouldFallBack(e)) throw e;
    if (market === 'futures') { futuresViaMexc = true; fellBack('perp ticker', 'MEXC'); return mexcTicker(symbol); }
    if (spotBase === SPOT) { spotBase = SPOT_MIRROR; fellBack('spot ticker', 'data-api.binance.vision'); return ticker24h(market, symbol); }
    throw e;
  }
}
