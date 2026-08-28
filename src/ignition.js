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
import { maxLev } from './leverage.js';

export const DEFAULTS = {
  coilBars:   24,     // the coil window — 2h on 5m
  histBars:   288,    // history the coil is ranked against — a day on 5m
  tightRank:  25,     // coiled = range in the tightest N% of its own history
  dryVol:     1.00,   // …and coil volume no higher than this × its baseline
  igniteAtr:  2.50,   // trigger candle range, in ATR
  igniteVol:  2.20,   // trigger candle volume, vs the 20-bar average
  minPower:   6.00,   // range × volume — one violent candle, not two mediocre ones
  minRangePct: 1.50,  // …and it has to be a real move in its own right
  bodyMin:    0.50,   // body / range — a real move, not a wick
  closeMin:   0.60,   // close in the top (or bottom) share of the candle
  breakBuf:   0.10,   // close beyond the base by this × ATR
  minRisk:    0.80,   // stop no tighter than this × ATR
  failBars:   8,      // a break that closes back inside within this many bars failed
  squeezeMem: 36,     // how far back the base may be — 3h on 5m
  fireWindow: 2,      // a break is "fresh" for this many bars
  trailGive:  0.25,   // once running, exit this far back from the best price
  maxCoilPct: 5.00,   // a 'coil' wider than this is just a trading range
  useLev:     0       // 0 = the exchange maximum; see the note on sizing
};

const TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000 };
// Bars fetched before the window opens so the indicators are warm at its edge.
const WARMUP = 300;

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// The rolling measurements every read shares: how tight the box is at each
// bar, how dry the volume is, and whether a given bar breaks a given box.
// The live read and the historical walk both go through this, so the rules
// cannot drift apart between them.
function prepare(bars, c) {
  const n = bars.length;

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
    // Breaks out of a wide box are not coil releases, they are noise inside a
    // range. Over 2,510 backtested ignitions the ones leaving boxes wider than
    // 5% averaged −34% at MEXC leverage and carried 8% of the profit.
    if (hi > 0 && (hi - lo) / hi * 100 > c.maxCoilPct) return null;
    if (rangeX * volX < c.minPower || rangePct < c.minRangePct) return null;
    if (bodyRatio < c.bodyMin || closePos < c.closeMin) return null;

    // Plan: stop past the far side of the ignition candle, targets a measured
    // move of the base it just left. Coils resolve about as far as they were
    // wide, and these things often go much further — hence TP2 and a trail.
    const boxH = hi - lo;
    const entry = C[i];
    // Targets are kept for reference, but the plan is the trail. A fixed
    // take-profit sized to the box banks two box-heights and hands back
    // everything after it — on a coin that runs 200% that is most of the
    // trade. Across 2,510 backtested ignitions, giving back 25% from the peak
    // instead of selling at TP2 turned +7.4% average into +42.0% at the same
    // leverage, and turned BMT's +285% into +12,577%. It wins fewer trades
    // (25% vs 32%); it keeps the ones that matter.
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
      side,
      // The measured edge, so the alert layer can act on it instead of the
      // reader having to remember: longs averaged +3.0% per trade at MEXC
      // leverage, shorts −29.3%. Same setup, same rules, opposite sign.
      grade: side === 'LONG' ? 'A' : 'B',
      barTime: bars[i].t, barsAgo: n - 1 - i,
      price: C[i], boxHi: hi, boxLo: lo,
      boxWidthPct: hi > 0 ? (hi - lo) / hi * 100 : null,
      coilBars: c.coilBars,
      baseTime: null,
      rangeX, volX, rangePct, power: rangeX * volX, bodyRatio, closePos,
      entry, stop, tp1, tp2,
      trailGive: c.trailGive,
      riskPct: entry > 0 ? risk / entry * 100 : null,
      rr1: risk > 0 ? Math.abs(tp1 - entry) / risk : null,
      movePct: side === 'LONG' ? (C[i] - hi) / hi * 100 : (lo - C[i]) / lo * 100
    };
  };

  return { n, O, H, L, C, V, A, VS, boxHi, boxLo, width, rankAt, dryAt, squeezeAt, fireAt };
}

// One symbol's state right now: how coiled it is, and whether it just went.
export function ignition(candles, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const bars = (candles || []).filter(b => b && b.closed !== false);
  if (bars.length < c.coilBars + 30) return null;
  const { n, C, V, A, boxHi, boxLo, width, rankAt, dryAt, squeezeAt, fireAt } = prepare(bars, c);

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

// Every ignition in a series, oldest first — the same rules the live read
// applies, walked across history so the setup can be measured instead of
// argued about.
//
// One difference, deliberately: the live read's "did this break fail" check is
// hindsight (it needs the bars after the break), and at the moment of a break
// there are none, so a live alert never gets that filter. The walk doesn't
// apply it either, or the results would flatter a signal you cannot trade.
export function ignitionEvents(candles, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const bars = (candles || []).filter(b => b && b.closed !== false);
  if (bars.length < c.coilBars + 30) return [];
  const { n, boxHi, boxLo, squeezeAt, fireAt } = prepare(bars, c);

  const events = [];
  let base = -1, spent = false;
  for (let i = c.coilBars; i < n; i++) {
    if (squeezeAt(i)) { base = i; spent = false; continue; }
    if (base < 0 || spent) continue;
    if (i - base > c.squeezeMem) { base = -1; continue; }   // the base went stale
    const f = fireAt(i, boxHi[base], boxLo[base]);
    if (!f) continue;
    f.baseTime = bars[base].t;
    f.coilBars = i - base + c.coilBars;
    f.bar = i;
    events.push(f);
    spent = true;                                          // first break only
  }
  return events;
}

// What a past ignition actually paid, under the exit the backtest chose: no
// fixed target, a stop that follows the best price and closes `give` below it.
// Across 2,510 backtested ignitions this returned +42.0% per trade at MEXC's
// leverage against the fixed target's +7.4%, and captured 79% of the peak.
//
// The stop is tested before the trail is raised on every bar, so a candle that
// takes out the stop and then runs counts as a loss — the same order the
// backtest uses, because a hopeful ordering here would quietly inflate the
// track record the app shows.
export function simulateTrail(bars, ev, cfg = {}) {
  const give = cfg.trailGive ?? DEFAULTS.trailGive;
  const i = ev.bar;
  const entry = bars[i + 1];
  if (!entry) return null;
  const long = ev.side === 'LONG';
  const fill = entry.o;
  const fav = p => (long ? p - fill : fill - p) / fill * 100;
  const adv = p => (long ? fill - p : p - fill) / fill * 100;

  let stop = ev.stop, peak = fill, mae = 0, mfe = 0;
  let peakPrice = fill, peakTime = entry.t;   // where the move actually topped
  for (let k = i + 1; k < bars.length; k++) {
    const b = bars[k];
    const a = adv(long ? b.l : b.h);
    if (a > mae) mae = a;
    const g = fav(long ? b.h : b.l);
    if (g > mfe) { mfe = g; peakPrice = long ? b.h : b.l; peakTime = b.t; }

    if (long ? b.l <= stop : b.h >= stop) {
      return { entryTime: entry.t, entry: fill, exitTime: b.t, exit: stop, open: false,
               peakTime, peakPrice, pnlPct: fav(stop), peakPct: mfe, dipPct: mae, bars: k - i };
    }
    peak = long ? Math.max(peak, b.h) : Math.min(peak, b.l);
    const t = long ? peak * (1 - give) : peak * (1 + give);
    stop = long ? Math.max(stop, t) : Math.min(stop, t);
  }
  const last = bars[bars.length - 1];
  return { entryTime: entry.t, entry: fill, exitTime: last.t, exit: last.c, open: true,
           peakTime, peakPrice, pnlPct: fav(last.c), peakPct: mfe, dipPct: mae, bars: bars.length - 1 - i };
}

// What to actually trade this at.
//
// An earlier version of this note argued for 25x on the strength of a 110%
// drawdown at maximum leverage. That test was wrong: it staked a fixed $1 while
// the account shrank, so the stake grew as a share of the wallet until it broke
// the account. Staking a fixed percentage instead — which can never reach zero —
// max leverage wins at every size tested over the same 353 trades:
//
//   stake     25x final    max final    max drawdown
//   0.5%          $806        $2,070            43%
//   1%          $3,528       $17,137            68%
//   2%         $34,112      $269,554            91%
//
// Leverage decides how often you are liquidated (196 of 353 trades at max, 36
// at 25x, and no stake size changes that). Stake size decides whether those
// liquidations matter. They are separate dials and this one is set to max on
// the user's instruction, with the survivable figure still shown beside it.
export const tradeLev = (market, symbol, cfg = {}) => {
  const cap = maxLev(market, symbol) || 1;
  const want = cfg.useLev ?? DEFAULTS.useLev;
  return Math.max(1, want > 0 ? Math.min(want, cap) : cap);
};

// A deeper look back than the live sweep holds.
//
// The sweep's 500 bars are one request per coin and cover about twenty days of
// 1h. Going back a year needs six pages per coin, so this is a separate,
// bounded pass: fewer coins, chosen by volume, fetched deep. Keeping it apart
// means asking for a year of history never slows down the question the sweep
// exists to answer — what is igniting right now.
export async function scanHistory({
  market = 'futures',
  interval = '1h',
  days = 30,
  coins = 80,
  minQuoteVol = 3e6,
  concurrency = 6,
  cfg = {},
  fetchCandlesDeep
} = {}) {
  if (typeof fetchCandlesDeep !== 'function') throw new Error('scanHistory needs fetchCandlesDeep');
  const ms = TF_MS[interval] || 3600000;
  const bars = Math.min(9000, Math.max(500, Math.ceil(days * 86400000 / ms) + WARMUP));
  const from = Date.now() - days * 86400000;

  const list = (await universe(market, minQuoteVol))
    .sort((a, b) => b.quoteVol - a.quoteVol).slice(0, coins);

  const per = await mapLimit(list, concurrency, async (row) => {
    const candles = await fetchCandlesDeep(market, row.symbol, interval, bars);
    if (candles.length < 200) return null;
    const lev = maxLev(market, row.symbol) || 1;
    return ignitionEvents(candles, cfg).map(ev => {
      const o = simulateTrail(candles, ev, cfg);
      if (!o || o.entryTime < from) return null;
      const dead = o.dipPct >= 100 / lev;
      const use = tradeLev(market, row.symbol, cfg);
      const deadUse = o.dipPct >= 100 / use;
      return {
        symbol: row.symbol, market, interval, side: ev.side, maxLev: lev, useLev: use,
        coilPct: ev.boxWidthPct, volX: ev.volX, ...o,
        atMaxLev: dead ? -100 : o.pnlPct * lev,
        peakAtMaxLev: dead ? -100 : o.peakPct * lev,
        atUseLev: deadUse ? -100 : o.pnlPct * use,
        liquidated: dead
      };
    }).filter(Boolean);
  });

  const rows = per.filter(Boolean).flat();
  return {
    at: Date.now(), market, interval, days, bars,
    coins: per.filter(Boolean).length, asked: list.length,
    reach: rows.length ? Math.min(...rows.map(r => r.entryTime)) : null,
    rows: rows.sort((a, b) => b.atMaxLev - a.atMaxLev)
  };
}

const PER_DAY = { '1m': 1440, '3m': 480, '5m': 288, '15m': 96, '30m': 48, '1h': 24, '4h': 6 };

// What the coin looked like BEFORE it fired, and what the market was doing.
//
// The trigger candle says nothing useful — volume, range and coil width all
// failed to separate winners from losers across 2,500 trades. These four did,
// on a time split where the rules were found in the older half and scored on a
// newer half they had never seen:
//
//   not within 3% of its 30-day high   worse in both halves if it is
//   coin flat or down over 7 days      better in both halves
//   BTC up over the last 7 days        better in both halves
//   the coin's own ATR under 1%        better in both halves
//
// Together, on the held-out half: win rate 24% → 50%, average per trade
// +70.7% → +206.4% at 10x. It is the opposite of chasing — a quiet coin that
// has not moved yet, well below its high, while the market as a whole rises.
export function marketContext(candles, interval, btcCandles = null) {
  const per = PER_DAY[interval] || 24;
  const n = candles.length;
  if (n < 2) return null;
  const i = n - 1, c = candles[i].c;
  const look = k => candles.slice(Math.max(0, i - k), i);

  const month = look(30 * per);
  const hi30 = month.length ? Math.max(...month.map(b => b.h)) : null;
  const ret = k => { const p = candles[i - k]?.c; return p ? (c - p) / p * 100 : null; };
  const win = look(14);
  const atr = win.length ? win.reduce((s, b) => s + (b.h - b.l), 0) / win.length : null;

  let btc7d = null;
  if (btcCandles?.length > 7 * per) {
    const b = btcCandles, j = b.length - 1, p = b[j - 7 * per]?.c;
    if (p) btc7d = (b[j].c - p) / p * 100;
  }
  return {
    fromHigh30: hi30 ? (c - hi30) / hi30 * 100 : null,
    ret7d: ret(7 * per),
    atrPct: atr && c > 0 ? atr / c * 100 : null,
    btc7d,
    // Enough history to judge? Without a month behind it the answer is "unknown",
    // which must not read as "passes".
    complete: month.length >= 20 * per
  };
}

// A is the tested edge, B is everything else. Nothing is hidden — the board
// shows both — but only A is worth being woken up for.
export function gradeSetup(side, ctx) {
  if (side !== 'LONG') return { grade: 'B', why: 'short — lost money at leverage across the backtest' };
  if (!ctx?.complete) return { grade: 'B', why: 'not enough history to judge the setup' };
  const fails = [];
  if (!(ctx.fromHigh30 < -3)) fails.push('already at its 30-day high');
  if (!(ctx.ret7d <= 0)) fails.push('already up over 7 days');
  if (!(ctx.btc7d > 0)) fails.push('BTC falling this week');
  if (!(ctx.atrPct < 1)) fails.push('too volatile to be a real coil');
  return fails.length ? { grade: 'B', why: fails.join(' · ') }
                      : { grade: 'A', why: 'quiet coin below its high, market rising' };
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
  bars = 900,          // still one request; 900 buys the ~30 days the grade needs
  concurrency = 8,
  cfg = {},
  fetchCandles                      // injected so this module stays testable
} = {}) {
  if (typeof fetchCandles !== 'function') throw new Error('scanUniverse needs a fetchCandles function');

  const list = await universe(market, minQuoteVol);
  // One extra request for the tide every signal is graded against.
  const btcCandles = await fetchCandles(market, 'BTCUSDT', interval, bars).catch(() => null);

  const results = await mapLimit(list, concurrency, async (row) => {
    const candles = await fetchCandles(market, row.symbol, interval, bars);
    const state = ignition(candles, cfg);
    if (!state) return null;
    const ctx = marketContext(candles, interval, btcCandles);
    if (state.fired) {
      const g = gradeSetup(state.fired.side, ctx);
      state.fired.grade = g.grade;
      state.fired.gradeWhy = g.why;
      state.fired.ctx = ctx;
      state.fired.useLev = tradeLev(market, row.symbol, cfg);
      state.fired.maxLev = maxLev(market, row.symbol) || 1;
    }
    // The candles are already here, so the track record of what this setup
    // caught in the same window is free — no extra request per coin.
    const lev = maxLev(market, row.symbol) || 1;
    const past = ignitionEvents(candles, cfg).map(ev => {
      const o = simulateTrail(candles, ev, cfg);
      if (!o) return null;
      // Liquidation lands near 100/leverage against you; a trade that got
      // there never collected the rest, whatever the chart did afterwards.
      const dead = o.dipPct >= 100 / lev;
      const use = tradeLev(market, row.symbol, cfg);
      const deadUse = o.dipPct >= 100 / use;
      return {
        symbol: row.symbol, market, interval, side: ev.side, maxLev: lev, useLev: use,
        coilPct: ev.boxWidthPct, volX: ev.volX, ...o,
        atMaxLev: dead ? -100 : o.pnlPct * lev,
        peakAtMaxLev: dead ? -100 : o.peakPct * lev,
        atUseLev: deadUse ? -100 : o.pnlPct * use,
        liquidated: dead
      };
    }).filter(Boolean);
    return { ...row, market, interval, ...state, ctx, past };
  });

  const ok = results.filter(Boolean);
  return {
    at: Date.now(),
    market, interval,
    scanned: list.length,
    analysed: ok.length,
    igniting: ok.filter(r => r.fired).sort((a, b) => b.fired.volX - a.fired.volX),
    coiling: ok.filter(r => !r.fired && r.coil.squeezed).sort((a, b) => b.readiness - a.readiness),
    history: ok.flatMap(r => r.past).sort((a, b) => b.atMaxLev - a.atMaxLev)
  };
}

// A whole-market sweep is ~300 klines calls, so the API layers share one
// cached runner rather than re-scanning for every page that asks.
export class IgnitionScanner {
  constructor(fetchCandles, getCfg = () => ({}), fetchDeep = fetchCandles) {
    this.fetchCandles = fetchCandles;
    this.fetchDeep = fetchDeep;
    this.getCfg = getCfg;
    this.cache = null;
    this.inflight = null;
  }

  async history({ market = 'futures', interval = '1h', days = 30, coins = 80, minQuoteVol = 3e6, ttl = 900000 } = {}) {
    const key = `${market}:${interval}:${days}:${coins}:${minQuoteVol}`;
    this.hcache ||= null;
    if (this.hcache && Date.now() - this.hcache.at < ttl && this.hcache.key === key) return this.hcache;
    this.hflight ||= null;
    if (this.hflight) return this.hflight;
    this.hflight = scanHistory({
      market, interval, days, coins, minQuoteVol, cfg: this.getCfg(),
      fetchCandlesDeep: this.fetchDeep
    }).then(d => (this.hcache = { ...d, key }))
      .finally(() => { this.hflight = null; });
    return this.hflight;
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
