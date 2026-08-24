// Higher-timeframe direction for a coin.
//
// A 3m signal reads very differently depending on what the 1h is doing — a long
// into a falling 4h is a counter-trend scalp whether or not the entry rules say
// so. This computes that context per symbol and the cards show it.
//
// Direction comes from EMA 21/55 on closed bars, gated by ADX so a flat, chopping
// market reads as flat instead of flipping direction on noise.

import { ema, adx } from './indicators.js';
import { fetchCandles } from './providers.js';

export const TREND_TFS = ['15m', '1h', '4h'];
const BARS = 200;
const TTL = 5 * 60 * 1000;
const MIN_ADX = 18;          // below this the market has no usable direction
const MIN_SEP = 0.05;        // EMAs within this % of price is a dead heat

// Keyed by coin, not by watch — three timeframes of one symbol is three
// requests however many intervals of it are being watched.
const cache = new Map();

function classify(bars) {
  const closed = bars.filter(b => b.closed);
  if (closed.length < 60) return null;

  const close = closed.map(b => b.c);
  const high = closed.map(b => b.h);
  const low = closed.map(b => b.l);
  const i = close.length - 1;

  const fast = ema(close, 21)[i];
  const slow = ema(close, 55)[i];
  const strength = adx(high, low, close, 14).adx[i];
  if (fast === null || slow === null) return null;

  const sep = (fast - slow) / close[i] * 100;
  const weak = strength !== null && strength < MIN_ADX;
  const dir = Math.abs(sep) < MIN_SEP || weak ? 'FLAT' : sep > 0 ? 'UP' : 'DOWN';

  // Change across the window the EMAs cover, for a sense of scale.
  const back = close[Math.max(0, i - 55)];
  return {
    dir,
    adx: strength === null ? null : +strength.toFixed(1),
    sep: +sep.toFixed(2),
    changePct: +(((close[i] - back) / back) * 100).toFixed(2)
  };
}

async function forTf(market, symbol, tf) {
  const key = `${market}:${symbol}:${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  try {
    const bars = await fetchCandles(market, symbol, tf, BARS);
    const value = classify(bars);
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // Keep whatever was last known rather than blanking the card on one bad call.
    if (hit) return hit.value;
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
}

// Forex has no higher-timeframe feed here without burning Twelve Data's tiny
// free quota, so it is skipped rather than shown as flat.
export async function trendFor(market, symbol, tfs = TREND_TFS) {
  if (market === 'forex') return null;
  const out = {};
  for (const tf of tfs) out[tf] = await forTf(market, symbol, tf);
  const dirs = Object.values(out).filter(Boolean).map(t => t.dir);
  const up = dirs.filter(d => d === 'UP').length;
  const down = dirs.filter(d => d === 'DOWN').length;
  return {
    tfs: out,
    // "aligned" is the honest summary: all three agreeing is the only case
    // worth calling a trend, everything else is mixed.
    bias: dirs.length && up === dirs.length ? 'UP' : dirs.length && down === dirs.length ? 'DOWN' : 'MIXED'
  };
}

export const isStale = (market, symbol, tf) => {
  const hit = cache.get(`${market}:${symbol}:${tf}`);
  return !hit || Date.now() - hit.at >= TTL;
};
