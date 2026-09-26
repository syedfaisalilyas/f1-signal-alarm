// Replays the live A+ call rules (calls.js) over ~10 days of 5m history for
// every market the Calls page scans, and writes one row per trade with what
// it looked like at entry and how it played out under several exits.
//
//   node tools/calls-backtest.mjs [--days=10] [--only=crypto|gold|forex] [--max=500]
//   → $CACHE/trades.json   (analyse with tools/calls-learn.mjs)
//
// Costs are charged in R: crypto 0.08% round trip (taker both sides), gold
// $0.35, FX 1.2 pips. SL and TP in the same 5m bar count as SL. No news data
// exists for the past, so the news blackout is not replayed.

import fs from 'fs';
import path from 'path';
import { aplus, rollup, mexcGet, cryptoUniverse, FIXED, ema, atrAt, trend } from '../calls.js';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d;
const DAYS = +arg('days', 10), ONLY = arg('only', ''), MAX = +arg('max', 600);
const CACHE = process.env.CACHE || path.join(process.cwd(), 'tools/data/calls-bt');
fs.mkdirSync(CACHE, { recursive: true });
const RRS = [1, 1.5, 2, 2.5, 3], HOLD = 288;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';

async function mexcHist(sym) {
  const f = path.join(CACHE, `${sym}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3) return JSON.parse(fs.readFileSync(f));
  const out = new Map(), now = Math.floor(Date.now() / 1000), span = 1000 * 300;
  for (let end = now; end > now - DAYS * 86400 - 900 * 300; end -= span) {
    const d = (await mexcGet(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min5&start=${end - span}&end=${end}`)).data;
    if (!d?.time?.length) break;
    d.time.forEach((t, i) => out.set(t, { t, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +d.vol[i] }));
  }
  const bars = [...out.values()].sort((a, b) => a.t - b.t).filter(b => b.t + 300 <= now);
  fs.writeFileSync(f, JSON.stringify(bars));
  return bars;
}

async function dukaHist(inst) {
  const f = path.join(CACHE, `${inst.replace('/', '')}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 6 * 3600e3) return JSON.parse(fs.readFileSync(f));
  const out = new Map();
  let ts = Date.now();
  for (let k = 0; k < Math.ceil(DAYS * 288 / 900) + 2; k++) {
    const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=' + encodeURIComponent(inst) +
      `&offer_side=B&interval=5MIN&splits=true&stocks=true&limit=1000&time_direction=P&timestamp=${ts}&jsonp=_cb`;
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

const cost = (m, price) => m.cls === 'crypto' ? price * 0.0008 : m.cls === 'gold' ? 0.35 : (m.id.includes('JPY') ? 0.012 : 0.00012);
const SESS = h => h < 7 ? 'Asia' : h < 12 ? 'London' : h < 17 ? 'New York' : 'Late US';

function walk(m, m5, i, z) {
  const d = z.side, risk = Math.abs(z.entry - z.sl), fee = cost(m, z.entry) / risk;
  const res = {};
  for (const rr of RRS) res[rr] = null;
  let mfe = 0, at1R = false, be = null, bars = 0, exitBar = null;
  for (let k = i + 1; k < Math.min(m5.length, i + 1 + HOLD); k++) {
    const b = m5[k]; bars++;
    const best = ((d > 0 ? b.h : b.l) - z.entry) * d / risk, worst = ((d > 0 ? b.l : b.h) - z.entry) * d / risk;
    for (const rr of RRS) if (res[rr] == null) {
      if (worst <= -1) res[rr] = -1;
      else if (best >= rr) res[rr] = rr;
    }
    // 2.5R with the stop moved to entry after +1R
    if (be == null) { if (worst <= (at1R ? 0 : -1)) be = at1R ? 0 : -1; else if (best >= 2.5) be = 2.5; }
    if (res[2.5] == null) mfe = Math.max(mfe, Math.min(best, 2.5));
    if (best >= 1) at1R = true;
    if (res[2.5] != null && exitBar == null) exitBar = bars;
    if (RRS.every(rr => res[rr] != null) && be != null) break;
  }
  const last = m5[Math.min(m5.length - 1, i + HOLD)], mtm = (last.c - z.entry) * d / risk;
  for (const rr of RRS) if (res[rr] == null) res[rr] = Math.max(-1, Math.min(rr, mtm));
  if (be == null) be = Math.max(-1, Math.min(2.5, mtm));
  const net = {}; for (const rr of RRS) net[rr] = +(res[rr] - fee).toFixed(3);
  return { r: net, be: +(be - fee).toFixed(3), fee: +fee.toFixed(3), mfe: +mfe.toFixed(2), bars: exitBar ?? bars };
}

async function replay(m, m5, btcH1) {
  if (m5.length < 900) return [];
  const m15 = rollup(m5, 900), h1 = rollup(m5, 3600);
  const trades = [];
  let busyUntil = -1, p15 = 0, p1 = 0;
  for (let i = 800; i < m5.length - 1; i++) {
    const nowSec = m5[i].t + 320;
    while (p15 < m15.length && m15[p15].t + 900 <= nowSec) p15++;
    while (p1 < h1.length && h1[p1].t + 3600 <= nowSec) p1++;
    if (i <= busyUntil || p1 < 60) continue;
    if (m5[i].t - m5[i - 1].t > 1800) continue;                  // weekend gap
    const bars = { m5: m5.slice(i - 299, i + 1), m15: m15.slice(Math.max(0, p15 - 150), p15), h1: h1.slice(Math.max(0, p1 - 120), p1) };
    const z = aplus(m, bars, null, nowSec);
    if (z.status !== 'ready') continue;
    const out = walk(m, m5, i, z);
    busyUntil = i + out.bars;
    const hh = h1.slice(Math.max(0, p1 - 60), p1), hc = hh.map(b => b.c), e20 = ema(hc, 20), e50 = ema(hc, 50);
    const trig = m5[i], vAvg = m5.slice(i - 20, i).reduce((s, b) => s + b.v, 0) / 20;
    let btc = null;
    if (btcH1 && m.cls === 'crypto') {
      const bh = btcH1.filter(b => b.t + 3600 <= nowSec).slice(-120);
      if (bh.length >= 60) btc = trend(bh);
    }
    trades.push({
      id: m.id, cls: m.cls, t: m5[i].t, side: z.side > 0 ? 'buy' : 'sell',
      f: {
        session: SESS(new Date(nowSec * 1000).getUTCHours()),
        side: z.side > 0 ? 'buy' : 'sell',
        volRatio: +z.volRatio.toFixed(2),
        stopPct: +(Math.abs(z.entry - z.sl) / z.entry * 100).toFixed(3),
        stopAtr: +(Math.abs(z.entry - z.sl) / z.atr).toFixed(2),
        h1Gap: +((e20.at(-1) - e50.at(-1)) / hc.at(-1) * 100 * z.side).toFixed(3),
        chg24: +((hc.at(-1) / hc.at(-25) - 1) * 100 * z.side).toFixed(2),
        body: +(Math.abs(trig.c - trig.o) / z.atr).toFixed(2),
        volSpike: +(trig.v / (vAvg || 1)).toFixed(2),
        btc: btc == null ? null : btc === z.side ? 'with' : btc === 0 ? 'flat' : 'against',
        rank: m.rank ?? null
      },
      ...out
    });
  }
  return trades;
}

const universe = [];
if (!ONLY || ONLY !== 'crypto') for (const m of FIXED) if (!ONLY || m.cls === ONLY) universe.push(m);
let btcH1 = null;
if (!ONLY || ONLY === 'crypto') {
  const coins = (await cryptoUniverse()).slice(0, MAX);
  coins.slice().sort((a, b) => b.turnover - a.turnover).forEach((c, k) => { c.rank = k < 20 ? 'top20' : k < 100 ? 'top100' : k < 250 ? 'mid' : 'small'; });
  universe.push(...coins);
  btcH1 = rollup(await mexcHist('BTC_USDT'), 3600);
}

const all = [];
let done = 0;
const t0 = Date.now();
for (const m of universe) {
  try {
    const m5 = m.src === 'duka' ? await dukaHist(m.inst) : await mexcHist(m.msym);
    all.push(...await replay(m, m5, btcH1));
  } catch (e) { console.error(m.id, e.message); }
  if (++done % 50 === 0) console.error(`${done}/${universe.length} markets, ${all.length} trades, ${Math.round((Date.now() - t0) / 1000)}s`);
}

// herd: how many other markets fired the same way within the same 15 minutes
const byT = {};
for (const t of all) { const k = Math.floor(t.t / 900) + t.side; byT[k] = (byT[k] || 0) + 1; }
for (const t of all) t.f.herd = byT[Math.floor(t.t / 900) + t.side] - 1;

fs.writeFileSync(path.join(CACHE, 'trades.json'), JSON.stringify(all));
console.log(`${all.length} trades from ${universe.length} markets → ${path.join(CACHE, 'trades.json')}`);
