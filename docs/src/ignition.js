// Coil → ignition. The move you actually want to be early on.
//
// These moves have a shape. A coin goes quiet: the range collapses, volume
// dries up, nobody cares. Then one candle does more than the previous twenty
// put together and it doesn't come back. TAC on 27 Aug — hours of chop around
// 0.0045, then +80%, then −56% in half a day.
//
// Both halves of that are measurable, and they are measurable at different
// times. COMPRESSION is visible before anything happens, which is what puts a
// coin on the watchlist. IGNITION is visible on the first candle of the move,
// which is what fires the alarm. This module reports both.
//
// What it deliberately does not do is predict direction while the coin is
// still coiled. Nothing in the price of a dead coin knows whether the news is
// a listing or a rug. The edge is being on the first candle either way.

import { atr as atrSeries, sma } from './indicators.js';
import { SPOT_MIRROR, isGeoBlocked, mexcAllTickers } from './geofeed.js';

export const DEFAULTS = {
  coilBars:   24,     // the coil window — 2h on 5m
  histBars:   288,    // history the coil is ranked against — a day on 5m
  tightRank:  25,     // coiled = range in the tightest N% of its own history
  dryVol:     1.00,   // …and coil volume no higher than this × its baseline
  igniteAtr:  2.00,   // trigger candle range, in ATR
  igniteVol:  2.20,   // trigger candle volume, vs the 20-bar average
  minPower:   6.00,   // range × volume — one violent candle, not two mediocre ones
  minRangePct: 1.50,  // …and it has to be a real move in its own right
  bodyMin:    0.50,   // body / range — a real move, not a wick
  closeMin:   0.60,   // close in the top (or bottom) share of the candle
  breakBuf:   0.10,   // close beyond the base by this × ATR
  minRisk:    0.80,   // stop no tighter than this × ATR
  failBars:   8,      // a break that closes back inside within this many bars failed
  squeezeMem: 36,     // how far back the base may be — 3h on 5m
  fireWindow: 2       // a break is "fresh" for this many bars
};

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// One symbol's state right now: how coiled it is, and whether it just went.
export function ignition(candles, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const bars = (candles || []).filter(b => b && b.closed !== false);
  const n = bars.length;
  if (n < c.coilBars + 30) return null;

  const O = bars.map(b => b.o), H = bars.map(b => b.h);
  const L = bars.map(b => b.l), C = bars.map(b => b.c), V = bars.map(b => b.v);
  const A = atrSeries(H, L, C, 14);
  const VS = sma(V, 20);

  // rolling coil box, ending at each bar
  const boxHi = new Array(n).fill(null);
  const boxLo = new Array(n).fill(null);
  const width = new Array(n).fill(null);
  for (let i = c.coilBars - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - c.coilBars + 1; j <= i; j++) {
      if (H[j] > hi) hi = H[j];
      if (L[j] < lo) lo = L[j];
    }
    boxHi[i] = hi; boxLo[i] = lo;
    width[i] = C[i] > 0 ? (hi - lo) / C[i] * 100 : null;
  }

  // Where this coil's width sits in its own recent history. Absolute width is
  // useless across coins — 1% is dead for a meme and a stampede for BTC.
  const rankAt = (i) => {
    const from = Math.max(c.coilBars - 1, i - c.histBars);
    let below = 0, tot = 0;
    for (let j = from; j <= i; j++) {
      if (width[j] === null) continue;
      tot++;
      if (width[j] < width[i]) below++;
    }
    return tot > 1 ? below / (tot - 1) * 100 : 100;
  };

  const dryAt = (i) => {
    const from = Math.max(0, i - c.histBars);
    const base = mean(V.slice(from, i + 1));
    const coil = mean(V.slice(Math.max(0, i - c.coilBars + 1), i + 1));
    return base > 0 ? coil / base : 1;
  };

  const squeezeAt = (i) => i >= c.coilBars && rankAt(i) <= c.tightRank && dryAt(i) <= c.dryVol;

  // The break itself: bar i against the BASE — the box as it stood on the last
  // bar the coin was actually asleep. Using the trailing window instead would
  // punish the shakeout that so often precedes the move: one 4×ATR stop-run
  // widens the recent range, and the real leg an hour later no longer counts
  // as a breakout of anything. TAC dumped 7% at 02:45, then left the base for
  // good at 03:45. The base is what it left.
  const fireAt = (i, hi, lo) => {
    const a = A[i - 1], vAvg = VS[i - 1];
    if (!a || !vAvg || hi === null) return null;

    const rng = H[i] - L[i];
    if (rng <= 0) return null;

    const buf = a * c.breakBuf;
    const side = C[i] > hi + buf ? 'LONG' : C[i] < lo - buf ? 'SHORT' : null;
    if (!side) return null;

    const rangeX = rng / a;
    const volX = V[i] / vAvg;
    const rangePct = C[i] > 0 ? rng / C[i] * 100 : 0;
    const bodyRatio = Math.abs(C[i] - O[i]) / rng;
    const closePos = side === 'LONG' ? (C[i] - L[i]) / rng : (H[i] - C[i]) / rng;
    if (rangeX < c.igniteAtr || volX < c.igniteVol) return null;
    if (rangeX * volX < c.minPower || rangePct < c.minRangePct) return null;
    if (bodyRatio < c.bodyMin || closePos < c.closeMin) return null;

    // Plan: stop past the far side of the ignition candle, targets a measured
    // move of the base it just left. Coils resolve about as far as they were
    // wide, and these things often go much further — hence TP2 and a trail.
    const boxH = hi - lo;
    const entry = C[i];
    // Stop where the break would be proven wrong — back inside the base — but
    // never tighter than minRisk (noise), never wider than the candle itself.
    const floor = a * c.minRisk;
    let stop = side === 'LONG'
      ? Math.min(hi - buf, entry - floor)
      : Math.max(lo + buf, entry + floor);
    stop = side === 'LONG' ? Math.max(stop, L[i] - buf) : Math.min(stop, H[i] + buf);
    const risk = Math.abs(entry - stop);
    const tp1 = side === 'LONG' ? entry + boxH : entry - boxH;
    const tp2 = side === 'LONG' ? entry + boxH * 2 : entry - boxH * 2;

    return {
      side, barTime: bars[i].t, barsAgo: n - 1 - i,
      price: C[i], boxHi: hi, boxLo: lo,
      boxWidthPct: hi > 0 ? (hi - lo) / hi * 100 : null,
      coilBars: c.coilBars,
      baseTime: null,
      rangeX, volX, rangePct, power: rangeX * volX, bodyRatio, closePos,
      entry, stop, tp1, tp2,
      riskPct: entry > 0 ? risk / entry * 100 : null,
      rr1: risk > 0 ? Math.abs(tp1 - entry) / risk : null,
      movePct: side === 'LONG' ? (C[i] - hi) / hi * 100 : (lo - C[i]) / lo * 100
    };
  };

  const last = n - 1;

  // Anchor on the most recent bar this coin was asleep, then take the FIRST
  // break after it — not the latest. That is the candle you wanted to be on,
  // and anchoring there also means a move that keeps expanding for an hour
  // reports one ignition rather than twelve.
  let base = -1;
  for (let i = last; i >= Math.max(c.coilBars, last - c.squeezeMem); i--) {
    if (squeezeAt(i)) { base = i; break; }
  }

  // A break that closes straight back inside the base failed — that is the
  // stop-run before the move, not the move. Skip it and keep looking: TAC's
  // 02:45 break down was undone in four candles, and the leg that mattered
  // left the same base an hour later.
  const failed = (i, hi, lo) => {
    for (let k = i + 1; k <= Math.min(last, i + c.failBars); k++) {
      if (C[k] <= hi && C[k] >= lo) return true;
    }
    return false;
  };

  let fired = null;
  if (base >= 0) {
    const hi = boxHi[base], lo = boxLo[base];
    for (let i = base + 1; i <= last; i++) {
      const f = fireAt(i, hi, lo);
      if (!f) continue;
      if (failed(i, hi, lo)) continue;
      f.baseTime = bars[base].t;
      f.coilBars = last - base + c.coilBars;
      fired = f;
      break;
    }
  }

  // How ripe it looks while it is still asleep. This is the watchlist score —
  // no direction implied, only "this one is loaded".
  const rank = rankAt(last);
  const dry = dryAt(last);
  const boxH = boxHi[last] - boxLo[last];
  const edge = boxH > 0
    ? Math.min(boxHi[last] - C[last], C[last] - boxLo[last]) / boxH   // 0 = at an edge, .5 = mid
    : 0.5;
  const coilVol = mean(V.slice(last - c.coilBars + 1, last + 1));
  const push = coilVol > 0 ? mean(V.slice(last - 2, last + 1)) / coilVol : 1;

  const readiness = Math.round(clamp(
      (1 - clamp(rank, 0, 100) / 100) * 40          // tighter than its own history
    + clamp((1 - dry) / 0.4, 0, 1) * 15             // volume has dried up
    + (1 - clamp(edge / 0.5, 0, 1)) * 15            // pressed against an edge
    + clamp((push - 1) / 1.5, 0, 1) * 30,           // volume creeping back in flat price
    0, 100));

  const atrNow = A[last];
  return {
    time: bars[last].t,
    price: C[last],
    atrPct: atrNow && C[last] > 0 ? atrNow / C[last] * 100 : null,
    coil: {
      hi: boxHi[last], lo: boxLo[last],
      widthPct: width[last],
      tightRank: rank,
      dryRatio: dry,
      edge, push,
      squeezed: rank <= c.tightRank && dry <= c.dryVol
    },
    // pre-place these and the move takes you with it instead of leaving you behind
    trigger: {
      up: atrNow ? boxHi[last] + atrNow * c.breakBuf : boxHi[last],
      down: atrNow ? boxLo[last] - atrNow * c.breakBuf : boxLo[last]
    },
    readiness,
    fired
  };
}

// ─────────────────────────── market-wide scan ───────────────────────────

const BASE = { spot: 'https://api.binance.com/api/v3', futures: 'https://fapi.binance.com/fapi/v1' };
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  }));
  return out;
}

async function binanceTickers(base) {
  const res = await fetch(`${base}/ticker/24hr`, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${res.status} ticker/24hr`);
  return (await res.json()).map(t => ({
    symbol: t.symbol,
    price: +t.lastPrice,
    changePct: +t.priceChangePercent,
    quoteVol: +t.quoteVolume
  }));
}

// One ticker call gives the whole universe and its 24h volume — the only
// bulk request in the scan. Everything after it is one klines call per symbol.
//
// It needs the same geo fallback the candle feed has. Binance answers 451 to
// every US datacentre, which is exactly where the scheduled scanner runs, so
// without this the whole sweep dies on its first request there.
export async function universe(market = 'futures', minQuoteVol = 3e6) {
  let rows;
  try {
    rows = await binanceTickers(BASE[market]);
  } catch (e) {
    if (!isGeoBlocked(e)) throw e;
    rows = market === 'futures' ? await mexcAllTickers() : await binanceTickers(SPOT_MIRROR);
  }
  return rows
    .filter(t => t.symbol.endsWith('USDT') && !LEVERAGED.test(t.symbol))
    .filter(r => isFinite(r.quoteVol) && r.quoteVol >= minQuoteVol);
}

// Sweep every liquid perp and split it into "already going" and "loaded".
export async function scanUniverse({
  market = 'futures',
  interval = '5m',
  minQuoteVol = 3e6,
  bars = 220,
  concurrency = 8,
  cfg = {},
  fetchCandles                      // injected so this module stays testable
} = {}) {
  if (typeof fetchCandles !== 'function') throw new Error('scanUniverse needs a fetchCandles function');

  const list = await universe(market, minQuoteVol);
  const results = await mapLimit(list, concurrency, async (row) => {
    const candles = await fetchCandles(market, row.symbol, interval, bars);
    const state = ignition(candles, cfg);
    return state ? { ...row, market, interval, ...state } : null;
  });

  const ok = results.filter(Boolean);
  return {
    at: Date.now(),
    market, interval,
    scanned: list.length,
    analysed: ok.length,
    igniting: ok.filter(r => r.fired).sort((a, b) => b.fired.volX - a.fired.volX),
    coiling: ok.filter(r => !r.fired && r.coil.squeezed).sort((a, b) => b.readiness - a.readiness)
  };
}

// A whole-market sweep is ~300 klines calls, so the API layers share one
// cached runner rather than re-scanning for every page that asks.
export class IgnitionScanner {
  constructor(fetchCandles, getCfg = () => ({})) {
    this.fetchCandles = fetchCandles;
    this.getCfg = getCfg;
    this.cache = null;
    this.inflight = null;
  }

  async run({ market = 'futures', interval = '5m', minQuoteVol = 3e6, ttl = 90000 } = {}) {
    const key = `${market}:${interval}:${minQuoteVol}`;
    if (this.cache && Date.now() - this.cache.at < ttl && this.cache.key === key) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = scanUniverse({
      market, interval, minQuoteVol, cfg: this.getCfg(), fetchCandles: this.fetchCandles
    }).then(d => (this.cache = { ...d, key }))
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
