// The A+ pullback rules moved up a gear, to see if bigger timeframes and
// wider stops beat the 5m version once fees are paid.
//
//   A: 15m entry, trend on 15m + 1H + 4H
//   B: 1H entry,  trend on 1H + 4H + 1D
//
// Same logic as aplus() in calls.js: all three trends agree (EMA20 > EMA50,
// price past EMA50, EMA20 rising), a fresh 30-bar high/low in the last 15
// bars, a pullback into EMA20 ± 0.3 ATR, then a strong close out of it. Stop
// beyond the last 5 bars' swing, at least 1 ATR, skipped if wider than 2.5 ATR.
// Exits: fixed 1.5R / 2R / 2.5R / 3R, or a 1-ATR chandelier trail after +1R.
//
//   node tools/swing-backtest.mjs [--days=180] [--top=50]
//
// Costs in R: crypto 0.10% round trip (taker + a little slippage), gold $0.40.
// Funding is not charged. SL and TP in the same bar count as SL.

import fs from 'fs';
import path from 'path';
import { mexcGet, cryptoUniverse, ema, atrAt, trend } from '../calls.js';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d;
const DAYS = +arg('days', 180), TOP = +arg('top', 50);
const CACHE = process.env.CACHE || path.join(process.cwd(), 'tools/data/swing-bt');
fs.mkdirSync(CACHE, { recursive: true });
const RRS = [1.5, 2, 2.5, 3];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';

async function mexc15(sym) {
  const f = path.join(CACHE, `${sym}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(f));
  const out = new Map(), now = Math.floor(Date.now() / 1000), span = 1000 * 900;
  for (let end = now; end > now - DAYS * 86400; end -= span) {
    const d = (await mexcGet(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min15&start=${end - span}&end=${end}`)).data;
    if (!d?.time?.length) break;
    d.time.forEach((t, i) => out.set(t, { t, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +d.vol[i] }));
  }
  const bars = [...out.values()].sort((a, b) => a.t - b.t).filter(b => b.t + 900 <= now);
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars;
}

async function duka15(inst) {
  const f = path.join(CACHE, `${inst.replace('/', '')}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 12 * 3600e3) return JSON.parse(fs.readFileSync(f));
  const out = new Map();
  let ts = Date.now();
  for (let k = 0; k < Math.ceil(DAYS * 96 / 1000) + 2; k++) {
    const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=' + encodeURIComponent(inst) +
      `&offer_side=B&interval=15MIN&splits=true&stocks=true&limit=1000&time_direction=P&timestamp=${ts}&jsonp=_cb`;
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' } });
    const body = await r.text();
    const rows = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))).filter(Boolean);
    if (!rows.length) break;
    for (const x of rows) out.set(x[0] / 1000, { t: x[0] / 1000, o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] });
    ts = Math.min(...rows.map(x => x[0])) - 1;
  }
  const bars = [...out.values()].sort((a, b) => a.t - b.t);
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars;
}

// roll base bars up into sec-sized bars; partial buckets kept (only used once closed)
function roll(bars, sec) {
  const out = [];
  for (const b of bars) {
    const t = b.t - b.t % sec, last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

function pivots(b, k) {
  const hi = [], lo = [];
  for (let i = k; i < b.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (b[j].h > b[i].h) isH = false; if (b[j].l < b[i].l) isL = false; }
    if (isH) hi.push(b[i].h);
    if (isL) lo.push(b[i].l);
  }
  return { hi, lo };
}

// e = entry bars up to and including the signal bar; mid/hi = closed higher bars
function signal(e, mid, hi) {
  const i = e.length - 1, last = e[i], now = last.c;
  const tE = trend(e), tM = trend(mid), tH = trend(hi);
  if (!tE || tE !== tM || tM !== tH) return null;
  const d = tE, c = e.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), A = atrAt(e, i);
  const atrs = []; for (let k = i - 199; k <= i; k++) atrs.push(atrAt(e, k));
  if (A < 0.7 * atrs.sort((a, b) => a - b)[100]) return null;
  const piv = pivots(e.slice(-60), 3);
  if (d > 0 ? now <= (piv.lo.at(-1) ?? -Infinity) : now >= (piv.hi.at(-1) ?? Infinity)) return null;
  if (d > 0 ? now <= e50[i] : now >= e50[i]) return null;
  if (!e.slice(-3).some(b => d > 0 ? b.l <= e20[i] + 0.3 * A : b.h >= e20[i] - 0.3 * A)) return null;
  const impulse = [...Array(15).keys()].some(k => {
    const j = i - k, w = e.slice(j - 30, j);
    return d > 0 ? e[j].h > Math.max(...w.map(b => b.h)) : e[j].l < Math.min(...w.map(b => b.l));
  });
  if (!impulse) return null;
  const prev = e[i - 1], rng = last.h - last.l || 1e-9, body = (last.c - last.o) * d;
  const reject = body > 0 && body / rng >= 0.5 && rng >= 0.6 * A && (last.c - e20[i]) * d > 0 && (d > 0 ? last.c > prev.h : last.c < prev.l);
  if (!reject) return null;
  const swing = d > 0 ? Math.min(...e.slice(-5).map(b => b.l)) - 0.1 * A : Math.max(...e.slice(-5).map(b => b.h)) + 0.1 * A;
  const dist = Math.max(Math.abs(now - swing), A);
  if (dist > 2.5 * A) return null;
  const hp = pivots(mid.slice(-120), 2);
  const lvl = d > 0 ? hp.hi.filter(x => x > now + dist * 0.2).sort((a, b) => a - b)[0]
                    : hp.lo.filter(x => x < now - dist * 0.2).sort((a, b) => b - a)[0];
  const room = lvl ? Math.abs(lvl - now) / dist : Infinity;
  if (room < 1.5) return null;
  return { d, entry: now, dist, atr: A };
}

function walk(e, i, s, fee, hold) {
  const { d, entry, dist, atr } = s, res = {};
  let trail = null, trailSl = entry - d * dist, peak = entry, n = 0;
  for (let k = i + 1; k < Math.min(e.length, i + 1 + hold); k++) {
    const b = e[k]; n = k - i;
    const best = ((d > 0 ? b.h : b.l) - entry) * d / dist, worst = ((d > 0 ? b.l : b.h) - entry) * d / dist;
    for (const rr of RRS) if (res[rr] == null) { if (worst <= -1) res[rr] = -1; else if (best >= rr) res[rr] = rr; }
    if (trail == null) {
      if ((d > 0 ? b.l : b.h) * d <= trailSl * d) trail = (trailSl - entry) * d / dist;
      else {
        peak = d > 0 ? Math.max(peak, b.h) : Math.min(peak, b.l);
        if ((peak - entry) * d >= dist) trailSl = d > 0 ? Math.max(trailSl, peak - 1.5 * atr, entry) : Math.min(trailSl, peak + 1.5 * atr, entry);
      }
    }
    if (trail != null && RRS.every(rr => res[rr] != null)) break;
  }
  const last = e[Math.min(e.length - 1, i + hold)], mtm = (last.c - entry) * d / dist;
  for (const rr of RRS) if (res[rr] == null) res[rr] = Math.max(-1, Math.min(rr, mtm));
  if (trail == null) trail = Math.max(-1, mtm);
  const r = {}; for (const rr of RRS) r[rr] = res[rr] - fee;
  r.trail = trail - fee;
  return { r, bars: n };
}

function replay(m, base, mode) {
  const [eSec, mSec, hSec, hold] = mode === 'A' ? [900, 3600, 14400, 288] : [3600, 14400, 86400, 120];
  const e = eSec === 900 ? base : roll(base, eSec), mid = roll(base, mSec), hi = roll(base, hSec);
  const out = [];
  let busy = -1, pm = 0, ph = 0;
  for (let i = 300; i < e.length - 1; i++) {
    const nowSec = e[i].t + eSec;
    while (pm < mid.length && mid[pm].t + mSec <= nowSec) pm++;
    while (ph < hi.length && hi[ph].t + hSec <= nowSec) ph++;
    if (i <= busy || pm < 60 || ph < 60) continue;
    if (e[i].t - e[i - 1].t > 3 * eSec) continue;               // weekend gap
    const s = signal(e.slice(i - 299, i + 1), mid.slice(Math.max(0, pm - 150), pm), hi.slice(Math.max(0, ph - 150), ph));
    if (!s) continue;
    const fee = (m.cls === 'crypto' ? s.entry * 0.001 : 0.4) / s.dist;
    const w = walk(e, i, s, fee, hold);
    busy = i + w.bars;
    out.push({ id: m.id, cls: m.cls, mode, t: e[i].t, fee, stopPct: s.dist / s.entry * 100, ...w });
  }
  return out;
}

const coins = (await cryptoUniverse()).sort((a, b) => b.turnover - a.turnover).slice(0, TOP);
const all = [];
const t0 = Date.now();
let gold = null;
try { gold = await duka15('XAU/USD'); } catch (e) { console.error('gold', e.message); }
if (gold?.length > 1000) for (const mode of ['A', 'B']) all.push(...replay({ id: 'XAUUSD', cls: 'gold' }, gold, mode));
else console.error('gold: no Dukascopy data');
for (const [k, m] of coins.entries()) {
  try {
    const bars = await mexc15(m.msym);
    if (bars.length < 3000) continue;
    for (const mode of ['A', 'B']) all.push(...replay(m, bars, mode));
  } catch (e) { console.error(m.id, e.message); }
  if ((k + 1) % 10 === 0) console.error(`${k + 1}/${coins.length} coins, ${all.length} trades, ${Math.round((Date.now() - t0) / 1000)}s`);
}
fs.writeFileSync(path.join(CACHE, 'trades.json'), JSON.stringify(all));

// ─── report ───
const mid = Date.now() / 1000 - DAYS * 86400 / 2;
const line = (label, ts) => {
  if (!ts.length) return console.log(`  ${label.padEnd(22)} –`);
  const cols = [...RRS, 'trail'].map(x => {
    const rs = ts.map(t => t.r[x]), avg = rs.reduce((a, b) => a + b, 0) / rs.length, wr = rs.filter(r => r > 0).length / rs.length * 100;
    return `${String(x).padStart(5)}: ${(avg >= 0 ? '+' : '') + avg.toFixed(2)}R ${wr.toFixed(0).padStart(2)}%`;
  });
  const fee = ts.reduce((a, t) => a + t.fee, 0) / ts.length;
  console.log(`  ${label.padEnd(22)} n=${String(ts.length).padStart(4)} fee ${fee.toFixed(2)}R | ${cols.join(' | ')}`);
};
for (const mode of ['A', 'B']) {
  const T = all.filter(t => t.mode === mode);
  console.log(`\n${mode === 'A' ? 'A: 15m entry, 15m+1H+4H trend' : 'B: 1H entry, 1H+4H+1D trend'}   (per trade, after fees; % = win rate)`);
  line('all', T);
  line('  first half', T.filter(t => t.t < mid));
  line('  second half', T.filter(t => t.t >= mid));
  line('  last 30 days', T.filter(t => t.t >= Date.now() / 1000 - 30 * 86400));
  line('gold', T.filter(t => t.cls === 'gold'));
  line('crypto', T.filter(t => t.cls === 'crypto'));
  line('crypto top 10', T.filter(t => t.cls === 'crypto' && coins.findIndex(c => c.id === t.id) < 10));
}
