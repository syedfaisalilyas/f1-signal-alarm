// Confluence lab, step 1: every setup the concepts can produce, with every
// confluence reading at that moment and how the trade played out.
//
//   node tools/lab/events.mjs [--days=180] [--top=50]
//   → $CACHE/events.json    (analyse with tools/lab/analyse.mjs)
//
// Data: Binance USDT perps, 15m klines (with taker buy volume = order flow),
// funding history; gold from Dukascopy 15m (no order flow there, so those
// checks read neutral). Everything is computed from closed bars only; swing
// pivots count only once confirmed.
//
// Entries (enter at the signal bar's close):
//   sweep     wick trap: takes out the 20-bar low/high and closes back inside
//   sr        rejection off a 1H support/resistance level
//   fib       0.5–0.786 pullback of a fresh impulse + reversal bar
//   breakout  close past the 48-bar range with a volume spike
//   pullback  trend pullback to EMA20 on 15m with 1H + 4H trend (the old A+)
//   rsi       RSI < 25 / > 75 then a reversal bar
//   absorb    heavy selling for 2h, then a bar where buyers take over (and mirror)
// Exits: stop from the setup, targets 0.5 / 0.75 / 1 / 1.5 / 2 R, 24h time stop.
// Costs in R: crypto 0.10% round trip, gold $0.40. SL and TP in one bar = SL.

import fs from 'fs';
import path from 'path';
import { ema, atrAt } from '../../calls.js';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d;
const DAYS = +arg('days', 180), TOP = +arg('top', 50);
const CACHE = process.env.CACHE || path.join(process.cwd(), 'tools/data/lab');
fs.mkdirSync(CACHE, { recursive: true });
export const TPS = [0.5, 0.75, 1, 1.5, 2];
const HOLD = 96;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function json(url) {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status === 418) { await sleep(10000 * (t + 1)); continue; }
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (t === 4) throw e; await sleep(2000 * (t + 1)); }
  }
}
const cached = async (name, fn) => {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 24 * 3600e3) return JSON.parse(fs.readFileSync(f));
  const v = await fn(); fs.writeFileSync(f, JSON.stringify(v)); return v;
};

async function binanceBars(sym) {
  return cached(`${sym}.json`, async () => {
    const out = [], now = Date.now();
    let start = now - DAYS * 864e5;
    while (start < now) {
      const rows = await json(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=1500&startTime=${start}`);
      if (!rows.length) break;
      for (const x of rows) if (x[6] < now) out.push({ t: x[0] / 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], tb: +x[9] });
      start = rows.at(-1)[0] + 1;
      await sleep(250);
    }
    return out;
  });
}
async function funding(sym) {
  return cached(`${sym}-funding.json`, async () => {
    const out = [];
    let start = Date.now() - DAYS * 864e5;
    for (let k = 0; k < 3; k++) {
      const rows = await json(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1000&startTime=${start}`);
      if (!rows.length) break;
      out.push(...rows.map(x => ({ t: x.fundingTime / 1000, f: +x.fundingRate })));
      if (rows.length < 1000) break;
      start = rows.at(-1).fundingTime + 1;
    }
    return out;
  });
}
async function goldBars() {
  return cached('XAUUSD.json', async () => {
    const out = new Map();
    let ts = Date.now();
    for (let k = 0; k < Math.ceil(DAYS * 96 / 1000) + 3; k++) {
      const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=XAU%2FUSD' +
        `&offer_side=B&interval=15MIN&splits=true&stocks=true&limit=1000&time_direction=P&timestamp=${ts}&jsonp=_cb`;
      const body = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' } })).text();
      const rows = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))).filter(Boolean);
      if (!rows.length) break;
      for (const x of rows) out.set(x[0] / 1000, { t: x[0] / 1000, o: x[1], h: x[2], l: x[3], c: x[4], v: x[5], tb: null });
      ts = Math.min(...rows.map(x => x[0])) - 1;
    }
    return [...out.values()].sort((a, b) => a.t - b.t).filter(b => b.t > Date.now() / 1000 - DAYS * 86400);
  });
}

// ─── indicators over the whole series (value at i uses bars ≤ i only) ───
function rsiSeries(c, n = 14) {
  const out = Array(c.length).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
// higher-timeframe trend at each 15m bar, from HTF bars closed by then
function htfTrend(b, sec) {
  const out = Array(b.length).fill(0), hc = [];
  let cur = null, e20 = null, e50 = null, hist = [];
  const k20 = 2 / 21, k50 = 2 / 51;
  for (let i = 0; i < b.length; i++) {
    const bt = b[i].t - b[i].t % sec;
    if (cur && bt !== cur.t) {                         // previous HTF bar closed
      e20 = e20 == null ? cur.c : cur.c * k20 + e20 * (1 - k20);
      e50 = e50 == null ? cur.c : cur.c * k50 + e50 * (1 - k50);
      hc.push(cur.c); hist.push(e20);
      cur = null;
    }
    if (!cur) cur = { t: bt, c: b[i].c }; else cur.c = b[i].c;
    if (hc.length >= 60) {
      const c = hc.at(-1), e20p = hist.at(-6);
      out[i] = e20 > e50 && c > e50 && e20 > e20p ? 1 : e20 < e50 && c < e50 && e20 < e20p ? -1 : 0;
    }
  }
  return out;
}
// 1H support/resistance: confirmed 1H pivots (k=3) from the last 10 days
function levels(b) {
  const h1 = [];
  for (const x of b) {
    const t = x.t - x.t % 3600, last = h1.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, x.h); last.l = Math.min(last.l, x.l); last.end = x.t + 900; }
    else h1.push({ t, h: x.h, l: x.l, end: x.t + 900 });
  }
  const piv = [];                                       // { known, price, kind }
  for (let i = 3; i < h1.length - 3; i++) {
    let H = true, L = true;
    for (let j = i - 3; j <= i + 3; j++) { if (h1[j].h > h1[i].h) H = false; if (h1[j].l < h1[i].l) L = false; }
    const known = h1[i + 3].end;                        // confirmed once 3 more 1H bars closed
    if (H) piv.push({ known, t: h1[i].t, p: h1[i].h });
    if (L) piv.push({ known, t: h1[i].t, p: h1[i].l });
  }
  return piv.sort((a, b) => a.known - b.known);
}

function simulate(b, i, d, stop, fee) {
  const entry = b[i].c, dist = Math.abs(entry - stop), res = {};
  let n = 0;
  for (let k = i + 1; k < Math.min(b.length, i + 1 + HOLD); k++) {
    const x = b[k]; n = k - i;
    const best = ((d > 0 ? x.h : x.l) - entry) * d / dist, worst = ((d > 0 ? x.l : x.h) - entry) * d / dist;
    for (const tp of TPS) if (res[tp] == null) { if (worst <= -1) res[tp] = -1; else if (best >= tp) res[tp] = tp; }
    if (TPS.every(tp => res[tp] != null)) break;
  }
  const last = b[Math.min(b.length - 1, i + HOLD)], mtm = (last.c - entry) * d / dist;
  const r = {};
  for (const tp of TPS) r[tp] = +((res[tp] ?? Math.max(-1, Math.min(tp, mtm))) - fee).toFixed(3);
  return { r, bars: n };
}

function events(m, b, fund, btcTrend) {
  const n = b.length, c = b.map(x => x.c);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), rsi = rsiSeries(c);
  const atr = b.map((_, i) => i < 15 ? null : atrAt(b, i));
  const t1 = htfTrend(b, 3600), t4 = htfTrend(b, 14400), t15 = c.map((_, i) => i < 60 ? 0 :
    e20[i] > e50[i] && c[i] > e50[i] && e20[i] > e20[i - 5] ? 1 : e20[i] < e50[i] && c[i] < e50[i] && e20[i] < e20[i - 5] ? -1 : 0);
  const volAvg = i => { let s = 0; for (let k = i - 20; k < i; k++) s += b[k].v; return s / 20 || 1; };
  const hasFlow = b[0].tb != null;
  const buyRatio = (i, w) => { let tb = 0, v = 0; for (let k = i - w + 1; k <= i; k++) { tb += b[k].tb; v += b[k].v; } return v ? tb / v : 0.5; };
  const cvd = []; { let s = 0; for (const x of b) { s += hasFlow ? 2 * x.tb - x.v : 0; cvd.push(s); } }
  const piv = levels(b);
  // 15m swing pivots (k=5), confirmed 5 bars later
  const sw = [];
  for (let i = 5; i < n - 5; i++) {
    let H = true, L = true;
    for (let j = i - 5; j <= i + 5; j++) { if (b[j].h > b[i].h) H = false; if (b[j].l < b[i].l) L = false; }
    if (H) sw.push({ i, known: i + 5, p: b[i].h, hi: true });
    if (L) sw.push({ i, known: i + 5, p: b[i].l, hi: false });
  }
  let fp = 0, pp = 0, sp = 0;
  const known = [], swKnown = [];
  const out = [], busy = {};

  for (let i = 250; i < n - 1; i++) {
    const x = b[i], A = atr[i], nowT = x.t + 900;
    if (!A || b[i].t - b[i - 1].t > 2700) continue;
    while (pp < piv.length && piv[pp].known <= nowT) known.push(piv[pp++]);
    while (sp < sw.length && sw[sp].known <= i) swKnown.push(sw[sp++]);
    while (fp < fund.length - 1 && fund[fp + 1].t <= nowT) fp++;
    const lv = known.filter(p => p.t > nowT - 10 * 86400).map(p => p.p);
    const rng = x.h - x.l || 1e-12, bodyUp = x.c > x.o, bodyFrac = Math.abs(x.c - x.o) / rng;
    const lo20 = Math.min(...b.slice(i - 20, i).map(y => y.l)), hi20 = Math.max(...b.slice(i - 20, i).map(y => y.h));

    // last impulse leg from confirmed 15m swings
    const lastHi = swKnown.findLast(s => s.hi), lastLo = swKnown.findLast(s => !s.hi);
    const fibOf = d => {
      if (!lastHi || !lastLo) return null;
      if (d > 0 && lastLo.i < lastHi.i && lastHi.p - lastLo.p >= 3 * A) return (lastHi.p - x.l) / (lastHi.p - lastLo.p);
      if (d < 0 && lastHi.i < lastLo.i && lastHi.p - lastLo.p >= 3 * A) return (x.h - lastLo.p) / (lastHi.p - lastLo.p);
      return null;
    };

    const cands = [];
    for (const d of [1, -1]) {
      const rev = d > 0 ? bodyUp : !bodyUp;
      const wick = d > 0 ? (Math.min(x.o, x.c) - x.l) / rng : (x.h - Math.max(x.o, x.c)) / rng;
      // sweep / wick trap
      if ((d > 0 ? x.l < lo20 && x.c > lo20 : x.h > hi20 && x.c < hi20) && wick >= 0.5 && rng >= 0.8 * A)
        cands.push({ k: 'sweep', d, stop: d > 0 ? x.l - 0.1 * A : x.h + 0.1 * A });
      // S/R rejection
      const lvl = lv.filter(p => d > 0 ? p <= x.c && Math.abs(x.l - p) <= 0.2 * A : p >= x.c && Math.abs(x.h - p) <= 0.2 * A);
      if (lvl.length && rev && wick >= 0.3) {
        const p = d > 0 ? Math.min(...lvl) : Math.max(...lvl);
        cands.push({ k: 'sr', d, stop: d > 0 ? Math.min(x.l, p) - 0.3 * A : Math.max(x.h, p) + 0.3 * A });
      }
      // fib pullback
      const f = fibOf(d);
      if (f != null && f >= 0.5 && f <= 0.786 && rev && bodyFrac >= 0.4) {
        const leg = lastHi.p - lastLo.p, f786 = d > 0 ? lastHi.p - 0.786 * leg : lastLo.p + 0.786 * leg;
        cands.push({ k: 'fib', d, stop: d > 0 ? Math.min(x.l, f786) - 0.2 * A : Math.max(x.h, f786) + 0.2 * A });
      }
      // breakout
      const hi48 = Math.max(...b.slice(i - 48, i).map(y => y.h)), lo48 = Math.min(...b.slice(i - 48, i).map(y => y.l));
      if ((d > 0 ? x.c > hi48 : x.c < lo48) && x.v > 2 * volAvg(i) && rev && bodyFrac >= 0.5)
        cands.push({ k: 'breakout', d, stop: x.c - d * 1.5 * A });
      // trend pullback (old A+)
      if (t15[i] === d && t1[i] === d && t4[i] === d && rev && bodyFrac >= 0.5 && rng >= 0.6 * A &&
          b.slice(i - 3, i + 1).some(y => d > 0 ? y.l <= e20[i] + 0.3 * A : y.h >= e20[i] - 0.3 * A) && (x.c - e20[i]) * d > 0) {
        const s = d > 0 ? Math.min(...b.slice(i - 4, i + 1).map(y => y.l)) - 0.1 * A : Math.max(...b.slice(i - 4, i + 1).map(y => y.h)) + 0.1 * A;
        cands.push({ k: 'pullback', d, stop: s });
      }
      // RSI extreme reversal
      if ((d > 0 ? Math.min(rsi[i - 1], rsi[i - 2]) < 25 : Math.max(rsi[i - 1], rsi[i - 2]) > 75) && rev && bodyFrac >= 0.5)
        cands.push({ k: 'rsi', d, stop: d > 0 ? Math.min(x.l, b[i - 1].l, b[i - 2].l) - 0.1 * A : Math.max(x.h, b[i - 1].h, b[i - 2].h) + 0.1 * A });
      // absorption / order-flow flip
      if (hasFlow) {
        const before = buyRatio(i - 1, 8), now = x.tb / (x.v || 1);
        if ((d > 0 ? before < 0.46 && now > 0.58 : before > 0.54 && now < 0.42) && rev)
          cands.push({ k: 'absorb', d, stop: d > 0 ? Math.min(...b.slice(i - 3, i + 1).map(y => y.l)) - 0.1 * A : Math.max(...b.slice(i - 3, i + 1).map(y => y.h)) + 0.1 * A });
      }
    }

    for (const cd of cands) {
      const key = cd.k + cd.d;
      if (busy[key] > i) continue;
      const d = cd.d, dist = Math.abs(x.c - cd.stop);
      if (dist < 0.5 * A || dist > 3 * A || (cd.stop - x.c) * d >= 0) continue;
      const fee = (m.cls === 'crypto' ? x.c * 0.001 : 0.4) / dist;
      if (fee > 0.35) continue;
      // ─── confluence readings, +1 = with the trade, -1 = against, 0 = neutral ───
      const s = v => v > 0 ? 1 : v < 0 ? -1 : 0;
      const opp = lv.filter(p => d > 0 ? p > x.c : p < x.c).map(p => Math.abs(p - x.c)), nearOpp = opp.length ? Math.min(...opp) : Infinity;
      const onLvl = lv.some(p => d > 0 ? p <= x.c && Math.abs(x.l - p) <= 0.3 * A : p >= x.c && Math.abs(x.h - p) <= 0.3 * A);
      const f = fibOf(d);
      const swept = b.slice(i - 3, i + 1).some((y, k) => { const j = i - 3 + k, lo = Math.min(...b.slice(j - 20, j).map(z => z.l)), hi = Math.max(...b.slice(j - 20, j).map(z => z.h));
        return d > 0 ? y.l < lo && y.c > lo : y.h > hi && y.c < hi; });
      const br4 = hasFlow ? buyRatio(i, 4) : 0.5, br16 = hasFlow ? buyRatio(i, 16) : 0.5;
      // CVD divergence over 16 bars: price extreme vs flow extreme
      let div = 0;
      if (hasFlow) {
        const pl = Math.min(...b.slice(i - 16, i - 4).map(y => y.l)), ph = Math.max(...b.slice(i - 16, i - 4).map(y => y.h));
        const cl = Math.min(...cvd.slice(i - 16, i - 4)), ch = Math.max(...cvd.slice(i - 16, i - 4));
        const pl2 = Math.min(...b.slice(i - 4, i + 1).map(y => y.l)), ph2 = Math.max(...b.slice(i - 4, i + 1).map(y => y.h));
        const cl2 = Math.min(...cvd.slice(i - 4, i + 1)), ch2 = Math.max(...cvd.slice(i - 4, i + 1));
        if (d > 0 && pl2 < pl && cl2 > cl) div = 1; else if (d < 0 && ph2 > ph && ch2 < ch) div = 1;
        else if (d > 0 && ph2 > ph && ch2 < ch) div = -1; else if (d < 0 && pl2 < pl && cl2 > cl) div = -1;
      }
      const fr = fund[fp]?.f ?? 0, hr = new Date(nowT * 1000).getUTCHours();
      const conf = {
        t4: t4[i] * d, t1: t1[i] * d, t15: t15[i] * d,
        ema200: s((x.c - e200[i]) * d),
        sr: onLvl ? 1 : nearOpp < dist ? -1 : 0,
        fib: f != null && f >= 0.5 && f <= 0.786 ? 1 : 0,
        sweep: swept ? 1 : 0,
        delta: hasFlow ? (br4 - 0.5) * d > 0.03 ? 1 : (br4 - 0.5) * d < -0.03 ? -1 : 0 : 0,
        delta16: hasFlow ? (br16 - 0.5) * d > 0.02 ? 1 : (br16 - 0.5) * d < -0.02 ? -1 : 0 : 0,
        cvdDiv: div,
        vol: x.v > 1.5 * volAvg(i) ? 1 : 0,
        funding: m.cls !== 'crypto' ? 0 : d > 0 ? (fr < 0 ? 1 : fr > 0.0003 ? -1 : 0) : (fr > 0.0003 ? 1 : fr < 0 ? -1 : 0),
        rsi: d > 0 ? (rsi[i] < 40 ? 1 : rsi[i] > 70 ? -1 : 0) : (rsi[i] > 60 ? 1 : rsi[i] < 30 ? -1 : 0),
        btc: m.cls === 'crypto' && m.id !== 'BTCUSDT' ? (btcTrend.get(x.t) ?? 0) * d : 0,
        session: hr >= 7 && hr < 20 ? 1 : 0
      };
      const sim = simulate(b, i, d, cd.stop, fee);
      busy[key] = i + Math.max(4, sim.bars);
      out.push({ id: m.id, cls: m.cls, t: x.t, k: cd.k, d, fee: +fee.toFixed(3), stopAtr: +(dist / A).toFixed(2), conf, ...sim });
    }
  }
  return out;
}

const info = await json('https://fapi.binance.com/fapi/v1/ticker/24hr');
const perps = new Set((await json('https://fapi.binance.com/fapi/v1/exchangeInfo')).symbols
  .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => s.symbol));
const coins = info.filter(t => perps.has(t.symbol) && !/^(USDC|FDUSD|XAU|XAG|PAXG)/.test(t.symbol))
  .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP).map(t => t.symbol);
if (!coins.includes('BTCUSDT')) coins.unshift('BTCUSDT');

const btc = await binanceBars('BTCUSDT'), btcT = htfTrend(btc, 3600), btcTrend = new Map(btc.map((x, i) => [x.t, btcT[i]]));
const all = [];
const t0 = Date.now();
try {
  const g = await goldBars();
  all.push(...events({ id: 'XAUUSD', cls: 'gold' }, g, [], btcTrend));
  console.error(`gold: ${g.length} bars`);
} catch (e) { console.error('gold failed', e.message); }
for (const [k, sym] of coins.entries()) {
  try {
    const [b, f] = await Promise.all([binanceBars(sym), funding(sym)]);
    if (b.length < 2000) continue;
    all.push(...events({ id: sym, cls: 'crypto' }, b, f, btcTrend));
  } catch (e) { console.error(sym, e.message); }
  if ((k + 1) % 10 === 0) console.error(`${k + 1}/${coins.length} coins, ${all.length} events, ${Math.round((Date.now() - t0) / 1000)}s`);
}
fs.writeFileSync(path.join(CACHE, 'events.json'), JSON.stringify({ coins, made: Date.now(), days: DAYS, events: all }));
console.error(`done: ${all.length} events → ${path.join(CACHE, 'events.json')}`);
