// Everything about one coin, on one screen.
//
// The volatility board answers "what is moving". This answers the next four
// questions, which is what you actually need before risking money on it:
//
//   is it even tradeable   — 24h turnover, and how big a position that allows
//   what is it doing       — trend on six timeframes, and where price sits in it
//   where are the lines    — swing levels, volume shelves, fib zone of the swing
//   who is on which side   — taker buy share, OBV, funding, open interest, the
//                            long/short book — and whether that crowd is trapped
//
// Then it takes a side, or refuses to. A refusal is a result: a coiled coin
// with no level nearby has no trade in it yet, and saying so is more useful
// than dressing up a coin flip as a setup.
//
// One caution the numbers cannot state themselves: every reading here is
// descriptive. Wide hourly candles say a move is more likely than usual — they
// never say which way. COLLECT's 90% day on 5 Sep was DOWN.

import { fetchCandles, ticker24h } from './providers.js';
import { atr as atrSeries, sma, rsi } from './indicators.js';
import { buildProfile } from './volumeprofile.js';
import { trendFor } from './trend.js';
import { maxLev } from './leverage.js';

const FAPI = 'https://fapi.binance.com/fapi/v1';
const FDATA = 'https://fapi.binance.com/futures/data';

const median = a => { const s = [...a].filter(v => v > 0).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const pctOf = (hi, lo) => lo > 0 ? (hi - lo) / lo * 100 : null;
const r2 = v => v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(2);
// r2 is for percentages and ratios. Prices need significant digits instead —
// toFixed(2) turns 0.04444 into 0.04 and every level on a sub-cent coin into
// the same number.
const px = v => v === null || v === undefined || !isFinite(v) ? null : +v.toPrecision(8);

// Prices span 0.000012 to 90000 here, so a fixed decimal count is useless.
export function fmtPrice(p) {
  if (!(p > 0)) return '—';
  const d = p >= 1000 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : p >= 0.0001 ? 6 : 8;
  return p.toFixed(d);
}

async function jget(url, ms = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0].split('/').pop()}`);
  return res.json();
}

// ─── how much of this can you actually trade ───
function liquidity(t, h1) {
  const lastHourQuote = h1.length ? (h1.at(-1).qv ?? h1.at(-1).v * h1.at(-1).c) : 0;
  const day = t?.volume || 0;
  // A market maker's rule of thumb: stay under a small share of the flow you
  // are joining, or your own order is the move. Half a percent of an hour's
  // turnover fills without arguing on most books.
  const size = lastHourQuote * 0.005;
  const verdict = day < 2e6 ? 'thin' : day < 10e6 ? 'small' : day < 100e6 ? 'ok' : 'deep';
  const note = {
    thin: 'under $2M a day — the spread and slippage will eat a scalp. Not tradeable size.',
    small: 'a few million a day. Fine for small size, painful to exit in a hurry.',
    ok: 'enough turnover to get in and out at normal size.',
    deep: 'deep book — size is not your constraint here.'
  }[verdict];
  return { quoteVol: day, lastHourQuote, maxSize: size, verdict, note };
}

// ─── volatility, in the coin's own units ───
function volatility(h1, m5) {
  const closed = h1.filter(b => b.closed);
  const ranges = closed.map(b => pctOf(b.h, b.l) || 0);
  // Baseline excludes the last day, so a move underway cannot redefine "normal".
  const base = ranges.slice(0, Math.max(24, ranges.length - 24));
  const med = median(base);
  const ratio = i => med > 0 ? ranges[i] / med : 0;

  const last24 = ranges.slice(-24);
  const hot24 = last24.filter(v => med > 0 && v / med >= 2).length;
  const recent = median(ranges.slice(-12));

  // Where the expansion began: walk back from now while hours stay wide,
  // tolerating one quiet hour so a single calm candle doesn't reset the clock.
  let startIdx = null, misses = 0;
  for (let i = ranges.length - 1; i >= Math.max(0, ranges.length - 72); i--) {
    if (ratio(i) >= 1.8) { startIdx = i; misses = 0; }
    else if (++misses > 1) break;
  }
  const state = med <= 0 ? 'unknown'
    : recent / med <= 0.6 ? 'coiled'
    : recent / med >= 3 ? 'wild'
    : recent / med >= 1.6 ? 'expanding'
    : 'normal';

  const H = closed.map(b => b.h), L = closed.map(b => b.l), C = closed.map(b => b.c);
  const a1 = atrSeries(H, L, C, 14).at(-1);
  const m5c = m5.filter(b => b.closed);
  const a5 = m5c.length > 20
    ? atrSeries(m5c.map(b => b.h), m5c.map(b => b.l), m5c.map(b => b.c), 14).at(-1) : null;
  const price = C.at(-1) || 1;

  return {
    state,
    medianHourPct: r2(med),
    nowHourPct: r2(ranges.at(-1)),
    nowRatio: r2(ratio(ranges.length - 1)),
    recentRatio: r2(med > 0 ? recent / med : null),
    hotHours24: hot24,
    startedAt: startIdx === null ? null : closed[startIdx].t,
    atr1hPct: r2(a1 ? a1 / price * 100 : null),
    atr5mPct: r2(a5 ? a5 / price * 100 : null),
    // last two days of hourly candles — the strip the panel draws
    profile: closed.slice(-48).map(b => ({
      t: b.t, rangePct: r2(pctOf(b.h, b.l)), ratio: r2(med > 0 ? (pctOf(b.h, b.l) || 0) / med : null),
      chgPct: r2(pctOf(b.c, b.o)), up: b.c >= b.o
    })),
    note: {
      coiled: 'quiet — range is well under its own normal. This is the coil, not the move. Nothing to trade until it breaks.',
      normal: 'ordinary range for this coin. No urgency either way.',
      expanding: 'hourly range has stepped up. A move is more likely than usual — direction still has to come from somewhere else.',
      wild: 'already violent. Odds of a big day are high and so is the odds of being stopped out on noise. Size down, widen stops.',
      unknown: 'not enough history to judge what normal looks like here.'
    }[state]
  };
}

// ─── swing levels + volume shelves ───
function levels(h1, price, atr) {
  const closed = h1.filter(b => b.closed).slice(-320);
  const piv = [];
  const L = 3, R = 3;
  for (let i = L; i < closed.length - R; i++) {
    let isHi = true, isLo = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      if (closed[j].h >= closed[i].h) isHi = false;
      if (closed[j].l <= closed[i].l) isLo = false;
    }
    if (isHi) piv.push({ p: closed[i].h, t: closed[i].t, kind: 'high' });
    if (isLo) piv.push({ p: closed[i].l, t: closed[i].t, kind: 'low' });
  }
  // A level touched four times matters more than a one-off spike, so nearby
  // pivots collapse into one line carrying its own touch count.
  const tol = Math.max(atr * 0.5, price * 0.004);
  const clusters = [];
  for (const v of piv.sort((a, b) => a.p - b.p)) {
    const last = clusters.at(-1);
    if (last && v.p - last.p <= tol) { last.touches++; last.p = (last.p * (last.touches - 1) + v.p) / last.touches; last.at = Math.max(last.at, v.t); }
    else clusters.push({ p: v.p, touches: 1, at: v.t });
  }
  const dist = l => ({ p: px(l.p), price: px(l.p), distPct: r2((l.p - price) / price * 100), touches: l.touches, at: l.at });
  const vp = buildProfile(closed, closed.length - 1, { vpLen: 200 });

  return {
    support: clusters.filter(c => c.p < price).sort((a, b) => b.p - a.p).slice(0, 3).map(dist),
    resistance: clusters.filter(c => c.p > price).sort((a, b) => a.p - b.p).slice(0, 3).map(dist),
    poc: vp ? px(vp.poc) : null,
    vah: vp ? px(vp.vah) : null,
    val: vp ? px(vp.val) : null,
    vsPoc: vp ? (price > vp.poc ? 'above' : 'below') : null,
    // A shelf 150% away is a fact about last month, not a reference for today.
    pocDistPct: vp ? r2((vp.poc - price) / price * 100) : null
  };
}

// ─── the swing everyone is drawing fibs on ───
function fib(h1, price) {
  const closed = h1.filter(b => b.closed).slice(-240);
  if (closed.length < 30) return null;
  let hi = { p: -Infinity, i: 0 }, lo = { p: Infinity, i: 0 };
  closed.forEach((b, i) => {
    if (b.h > hi.p) hi = { p: b.h, i, t: b.t };
    if (b.l < lo.p) lo = { p: b.l, i, t: b.t };
  });
  const up = hi.i > lo.i;               // low came first = the leg was up
  const span = hi.p - lo.p;
  if (!(span > 0)) return null;
  const at = r => up ? hi.p - span * r : lo.p + span * r;
  const levels = [0.236, 0.382, 0.5, 0.618, 0.786].map(r => ({
    r, price: px(at(r)), distPct: r2((at(r) - price) / price * 100)
  }));
  // Retracement measured from the far end of the leg, so 0 = the extreme the
  // move ended on and 1 = where it started.
  const retr = up ? (hi.p - price) / span : (price - lo.p) / span;
  const zone = retr < 0 ? 'beyond the extreme (extension)'
    : retr <= 0.236 ? 'still at the extreme — no pullback yet'
    : retr <= 0.5 ? 'shallow pullback'
    : retr <= 0.66 ? 'the 0.618 pocket — where continuation entries live'
    : retr <= 0.9 ? 'deep pullback — the leg is in doubt'
    : 'fully retraced — the leg is done';
  return {
    dir: up ? 'up' : 'down',
    from: px(up ? lo.p : hi.p), to: px(up ? hi.p : lo.p),
    fromAt: up ? lo.t : hi.t, toAt: up ? hi.t : lo.t,
    retracement: r2(retr * 100), zone, levels,
    ext: [1.272, 1.618].map(r => ({ r, price: px(up ? lo.p + span * r : hi.p - span * r) }))
  };
}

// ─── stop hunts: the wick that took the level and gave it straight back ───
function wickTraps(m15) {
  const b = m15.filter(x => x.closed).slice(-120);
  if (b.length < 40) return [];
  const vAvg = sma(b.map(x => x.v), 20);
  const out = [];
  for (let i = 20; i < b.length; i++) {
    const c = b[i], rng = c.h - c.l;
    if (!(rng > 0) || !vAvg[i]) continue;
    const upWick = c.h - Math.max(c.o, c.c), dnWick = Math.min(c.o, c.c) - c.l;
    const priorHi = Math.max(...b.slice(i - 20, i).map(x => x.h));
    const priorLo = Math.min(...b.slice(i - 20, i).map(x => x.l));
    const heavy = c.v >= vAvg[i] * 1.5;
    if (upWick / rng >= 0.55 && c.h > priorHi && c.c < priorHi && heavy)
      out.push({ t: c.t, side: 'bearish', at: px(c.h), text: `swept the ${fmtPrice(priorHi)} highs and closed back under — longs trapped`, wickPct: r2(upWick / rng * 100) });
    if (dnWick / rng >= 0.55 && c.l < priorLo && c.c > priorLo && heavy)
      out.push({ t: c.t, side: 'bullish', at: px(c.l), text: `swept the ${fmtPrice(priorLo)} lows and closed back over — shorts trapped`, wickPct: r2(dnWick / rng * 100) });
  }
  return out.slice(-4).reverse();
}

// ─── who is leaning which way ───
async function flow(market, symbol, h1) {
  const closed = h1.filter(b => b.closed);
  const win = closed.slice(-24), win4 = closed.slice(-4);
  const haveTaker = win.every(b => typeof b.tb === 'number' && isFinite(b.tb));
  const buyShare = w => {
    const v = sum(w.map(b => b.v)), tb = sum(w.map(b => b.tb));
    return v > 0 ? tb / v * 100 : null;
  };

  // OBV on hourly closes. What matters is not its level but whether it agrees
  // with price: volume leaving while price holds up is distribution.
  let obv = 0; const series = [];
  for (let i = 1; i < closed.length; i++) {
    obv += closed[i].c > closed[i - 1].c ? closed[i].v : closed[i].c < closed[i - 1].c ? -closed[i].v : 0;
    series.push(obv);
  }
  const seg = series.slice(-24);
  const obvDir = seg.length > 2 ? (seg.at(-1) > seg[0] ? 'up' : seg.at(-1) < seg[0] ? 'down' : 'flat') : 'flat';
  const priceDir = win.length > 2 ? (win.at(-1).c > win[0].o ? 'up' : win.at(-1).c < win[0].o ? 'down' : 'flat') : 'flat';
  const divergence = obvDir !== 'flat' && priceDir !== 'flat' && obvDir !== priceDir
    ? (priceDir === 'up' ? 'price up on falling OBV — the rally is losing sponsorship' : 'price down on rising OBV — sellers are being absorbed')
    : null;

  const out = {
    takerBuy24h: haveTaker ? r2(buyShare(win)) : null,
    takerBuy4h: haveTaker ? r2(buyShare(win4)) : null,
    obvDir, priceDir, divergence,
    rsi1h: r2(rsi(closed.map(b => b.c), 14).at(-1)),
    derivs: null
  };

  // Funding, open interest and the long/short book are perp-only. A spot coin
  // borrows them from its own perp when one exists — same crowd, same lean.
  const perp = symbol.toUpperCase();
  try {
    const [prem, oi, top, glob, taker] = await Promise.all([
      jget(`${FAPI}/premiumIndex?symbol=${perp}`),
      jget(`${FDATA}/openInterestHist?symbol=${perp}&period=1h&limit=25`),
      jget(`${FDATA}/topLongShortPositionRatio?symbol=${perp}&period=1h&limit=2`),
      jget(`${FDATA}/globalLongShortAccountRatio?symbol=${perp}&period=1h&limit=2`),
      jget(`${FDATA}/takerlongshortRatio?symbol=${perp}&period=1h&limit=4`)
    ]);
    const oiNow = +oi.at(-1)?.sumOpenInterestValue || 0;
    const oiThen = +oi[0]?.sumOpenInterestValue || 0;
    const fr = +prem.lastFundingRate;
    out.derivs = {
      source: market === 'spot' ? 'perp' : 'self',
      funding: r2(fr * 100),                 // per 8h, in %
      fundingApr: r2(fr * 3 * 365 * 100),
      nextFunding: prem.nextFundingTime,
      oiUsd: oiNow,
      oiChg24h: oiThen > 0 ? r2((oiNow - oiThen) / oiThen * 100) : null,
      topLongPct: r2(+top.at(-1)?.longAccount * 100),
      crowdLongPct: r2(+glob.at(-1)?.longAccount * 100),
      takerRatio: r2(median(taker.map(x => +x.buySellRatio)))
    };
  } catch { /* geo-blocked, or no perp for this coin — the section just hides */ }

  // What the numbers mean together, in words, because the common reading of
  // them is wrong. "More buyers than sellers" is not a thing — every contract
  // bought was sold. What taker share measures is URGENCY: which side is
  // paying the spread. And a crowded side is only a fade when it is paying to
  // stay there AND price has stopped rewarding it. Crowded-and-still-winning
  // is just a trend.
  const d = out.derivs;
  const bits = [];
  if (out.takerBuy24h !== null) bits.push(
    `${out.takerBuy24h}% of the day's volume was market buys — ` +
    (out.takerBuy24h >= 55 ? 'buyers are the impatient side'
      : out.takerBuy24h <= 45 ? 'sellers are the impatient side' : 'neither side is in a hurry'));
  if (out.divergence) bits.push(out.divergence);
  if (d) {
    bits.push(d.funding >= 0.03 ? `longs are paying ${d.funding}% every 8h (${d.fundingApr}% a year) to hold`
      : d.funding <= -0.03 ? `shorts are paying ${Math.abs(d.funding)}% every 8h to hold`
      : 'funding is flat — neither side is paying much to be there');
    if (d.oiChg24h !== null) bits.push(
      d.oiChg24h >= 15 ? `open interest +${d.oiChg24h}% in a day — new positions coming in`
        : d.oiChg24h <= -15 ? `open interest ${d.oiChg24h}% — positions being closed, not opened`
        : 'open interest is steady');
    bits.push(`${d.crowdLongPct}% of retail accounts are long, ${r2(100 - d.crowdLongPct)}% short`);
  }
  out.read = bits;
  out.crowd = !d ? null
    : d.funding >= 0.05 && d.crowdLongPct >= 60 && out.priceDir !== 'up'
      ? { side: 'longs', text: 'Crowded long, paying for it, and price has stopped going up. That is the setup where a flush hurts — the fuel for a drop is the longs themselves.' }
    : d.funding <= -0.03 && d.crowdLongPct <= 40 && out.priceDir !== 'down'
      ? { side: 'shorts', text: 'Crowded short, paying for it, and price has stopped going down. A bounce here forces them to buy back.' }
    : { side: 'none', text: 'Positioning is leaning but nobody is trapped: the crowd is either not paying to be there, or price is still going their way. A lopsided book on its own is not a reason to take the other side.' };
  return out;
}

// ─── the part that has to commit ───
function plan({ price, vol, trend, lv, fb, traps, fl, liq, market, symbol }) {
  const bull = [], bear = [], blockers = [];
  const atr = price * (vol.atr1hPct || 2) / 100;

  const bias = trend?.bias;
  const dirs = Object.values(trend?.tfs || {}).filter(Boolean).map(x => x.dir);
  const allFlat = dirs.length >= 3 && dirs.every(d => d === 'FLAT');
  if (bias === 'UP') bull.push('15m, 1h and 4h all point up');
  else if (bias === 'DOWN') bear.push('15m, 1h and 4h all point down');
  else if (allFlat) blockers.push('no timeframe has a direction — this is chop, not a trend');
  else if (bias) blockers.push('higher timeframes disagree — 15m/1h/4h are not aligned');

  // The volume shelf only argues a case while price is near it.
  const pocNear = lv.poc !== null && Math.abs(lv.pocDistPct) <= 12;
  if (pocNear && lv.vsPoc === 'above') bull.push(`holding above the volume shelf at ${fmtPrice(lv.poc)}`);
  if (pocNear && lv.vsPoc === 'below') bear.push(`capped under the volume shelf at ${fmtPrice(lv.poc)}`);

  const nearSup = lv.support[0], nearRes = lv.resistance[0];
  const near = l => l && Math.abs(l.p - price) <= atr * 1.2;
  const touch = n => `${n} touch${n === 1 ? '' : 'es'}`;
  if (near(nearSup)) bull.push(`support ${fmtPrice(nearSup.p)} is ${Math.abs(nearSup.distPct)}% away, ${touch(nearSup.touches)}`);
  if (near(nearRes)) bear.push(`resistance ${fmtPrice(nearRes.p)} is ${Math.abs(nearRes.distPct)}% away, ${touch(nearRes.touches)}`);

  if (fb && fb.dir === 'up' && fb.retracement >= 50 && fb.retracement <= 66 && bias !== 'DOWN')
    bull.push('pulled back into the 0.618 pocket of the last up-leg');
  if (fb && fb.dir === 'down' && fb.retracement >= 50 && fb.retracement <= 66 && bias !== 'UP')
    bear.push('bounced into the 0.618 pocket of the last down-leg');

  const trap = traps[0];
  const fresh = trap && Date.now() - trap.t < 6 * 3600e3;
  if (fresh && trap.side === 'bullish') bull.push('a stop-run through the lows was bought back within the hour');
  if (fresh && trap.side === 'bearish') bear.push('a stop-run through the highs was sold back within the hour');

  if (fl.divergence?.startsWith('price up')) bear.push(fl.divergence);
  if (fl.divergence?.startsWith('price down')) bull.push(fl.divergence);
  if (fl.takerBuy24h !== null && fl.takerBuy24h >= 55) bull.push(`${fl.takerBuy24h}% of the day's volume hit the ask`);
  if (fl.takerBuy24h !== null && fl.takerBuy24h <= 45) bear.push(`${fl.takerBuy24h}% of the day's volume hit the ask — sellers in control`);

  // Crowding is only a fade when the crowd is PAYING to stay there and price
  // has stopped rewarding them. Positioning alone is not a signal.
  const d = fl.derivs;
  if (d) {
    const crowdedLong = d.funding >= 0.05 && d.crowdLongPct >= 60;
    const crowdedShort = d.funding <= -0.03 && d.crowdLongPct <= 40;
    if (crowdedLong && fl.priceDir !== 'up') bear.push(`longs pay ${d.funding}% every 8h and ${d.crowdLongPct}% of accounts are long, yet price has stopped rising — squeeze fuel`);
    if (crowdedShort && fl.priceDir !== 'down') bull.push(`shorts pay ${Math.abs(d.funding)}% every 8h and ${r2(100 - d.crowdLongPct)}% of accounts are short — a bounce hurts them`);
    if (d.oiChg24h !== null && d.oiChg24h >= 25 && fl.priceDir === 'up') bull.push(`open interest +${d.oiChg24h}% into a rising price — new money, not a short squeeze`);
    if (d.oiChg24h !== null && d.oiChg24h <= -20) blockers.push(`open interest ${d.oiChg24h}% — positions are leaving, moves here will be thin`);
  }

  if (liq.verdict === 'thin') blockers.push(liq.note);
  if (vol.state === 'coiled') blockers.push('the range is compressed — there is a level to wait at, not a move to take');
  if (vol.state === 'wild') blockers.push('range is 3× normal — anything you enter now needs a stop the size of a normal day');

  const score = bull.length - bear.length;
  const hard = blockers.find(b => b.startsWith('the range is compressed') || b === liq.note) || null;
  const side = hard || Math.abs(score) < 2 ? 'WAIT' : score > 0 ? 'LONG' : 'SHORT';

  let entry = null, stop = null, targets = [], riskPct = null, rr = null, lev = null;
  if (side === 'LONG') {
    entry = nearSup && nearSup.p > price - atr * 2 ? Math.max(nearSup.p, price - atr * 0.5) : price;
    stop = (nearSup ? nearSup.p : price - atr * 2) - atr * 0.6;
    // A level can sit half a percent away on a coin whose normal hour moves
    // more than that. A stop inside the noise is not risk control, it is a
    // donation, so it never comes closer than one hourly ATR.
    stop = Math.min(stop, entry - atr);
    targets = [nearRes?.p, lv.resistance[1]?.p, fb?.ext?.[0]?.price].filter(v => v > entry).slice(0, 2);
  } else if (side === 'SHORT') {
    entry = nearRes && nearRes.p < price + atr * 2 ? Math.min(nearRes.p, price + atr * 0.5) : price;
    stop = (nearRes ? nearRes.p : price + atr * 2) + atr * 0.6;
    stop = Math.max(stop, entry + atr);
    targets = [nearSup?.p, lv.support[1]?.p, fb?.ext?.[0]?.price].filter(v => v < entry).slice(0, 2);
  }
  if (entry && stop) {
    riskPct = Math.abs(entry - stop) / entry * 100;
    if (targets.length) rr = r2(Math.abs(targets[0] - entry) / Math.abs(entry - stop));
    // Size so the stop costs about 40% of the margin — the same rule the
    // screener quotes, so both screens mean the same thing by "leverage".
    const cap = maxLev(market, symbol) || 20;
    lev = Math.max(1, Math.min(cap, Math.floor(40 / riskPct)));
  }

  return {
    side, score, bull, bear, blockers,
    entry: px(entry), stop: px(stop), targets: targets.map(px),
    riskPct: r2(riskPct), rr, lev,
    // A "wait" still has two prices in it: waiting is waiting for something.
    triggers: [
      nearRes ? { side: 'LONG', text: `an hourly close above ${fmtPrice(nearRes.p)} opens ${lv.resistance[1] ? fmtPrice(lv.resistance[1].p) : 'the next shelf'}`, at: px(nearRes.p) } : null,
      nearSup ? { side: 'SHORT', text: `losing ${fmtPrice(nearSup.p)} on the hour opens ${lv.support[1] ? fmtPrice(lv.support[1].p) : 'the last swing low'}`, at: px(nearSup.p) } : null
    ].filter(Boolean),
    headline: side === 'WAIT'
      ? (hard ? 'No trade here yet: ' + hard : 'Two-sided — the evidence does not lean far enough either way')
      : `${side} — ${(side === 'LONG' ? bull : bear)[0]}`
  };
}

// ─── the whole picture ───
async function build(market, symbol, { withTrend = true } = {}) {
  const sym = symbol.toUpperCase();
  const [t, h1, m15, m5] = await Promise.all([
    ticker24h(market, sym).catch(() => null),
    fetchCandles(market, sym, '1h', 500),
    fetchCandles(market, sym, '15m', 200),
    fetchCandles(market, sym, '5m', 200)
  ]);
  if (!h1?.length) throw new Error(`no candles for ${sym}`);
  const price = t?.price || h1.at(-1).c;

  const vol = volatility(h1, m5);
  const atr = price * (vol.atr1hPct || 2) / 100;
  const liq = liquidity(t, h1.filter(b => b.closed));
  const lv = levels(h1, price, atr);
  const fb = fib(h1, price);
  const traps = wickTraps(m15);
  const [fl, trend] = await Promise.all([
    flow(market, sym, h1),
    withTrend ? trendFor(market, sym).catch(() => null) : null
  ]);

  return {
    at: Date.now(), market, symbol: sym,
    price, priceText: fmtPrice(price),
    changePct: r2(t?.changePct ?? null),
    maxLev: maxLev(market, sym) || null,
    liquidity: liq, volatility: vol, trend, levels: lv, fib: fb, traps, flow: fl,
    plan: plan({ price, vol, trend, lv, fb, traps, fl, liq, market, symbol: sym })
  };
}

// A report costs a dozen requests. Reopening the same coin inside a minute
// should be free, and two panels asking at once should be one scan.
const cache = new Map();
const inflight = new Map();

export async function coinReport(market = 'futures', symbol = '', opts = {}) {
  const key = `${market}:${symbol.toUpperCase()}`;
  const ttl = opts.ttl ?? 60000;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = build(market, symbol, opts)
    .then(r => { cache.set(key, r); return r; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
