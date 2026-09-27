// Confluence lab, round 2: bigger timeframes, years of data.
//
//   node tools/lab/htf.mjs [--top=50] [--from=2022-01-01]
//
// 4H bars (Binance USDT perps with taker volume + funding; gold from Dukascopy),
// daily and weekly rolled up from them. Entries:
//   dbreak  daily close past the 20-day high/low, stop 2 daily ATR
//   dflip   daily trend (EMA20/50, rising) turns on, stop 2 daily ATR
//   pb4     4H pullback to EMA20 inside the daily trend + strong 4H close
// Exits: fixed 1 / 1.5 / 2 / 3 R, or trail (stop to breakeven at +1R, then out
// on a 4H close through EMA20). Max hold 30 days (daily) / 10 days (pb4).
// Costs in R: crypto 0.10% round trip + 0.03%/day funding, gold $0.40 +
// $0.15/day swap. SL and TP in one bar = SL.
// Split: PICK < 2024-07 · CHECK < 2025-09 · EXAM = the last ~12 months.

import fs from 'fs';
import path from 'path';
import { ema } from '../../calls.js';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d;
const TOP = +arg('top', 50), FROM = Date.parse(arg('from', '2022-01-01'));
const CACHE = process.env.CACHE || path.join(process.cwd(), 'tools/data/lab-htf');
fs.mkdirSync(CACHE, { recursive: true });
const TPS = ['1', '1.5', '2', '3', 'trail'];
const CHECK = Date.parse('2024-07-01') / 1000, EXAM = Date.parse('2025-09-01') / 1000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(url) {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status === 418) { await sleep(10000 * (t + 1)); continue; }
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } catch (e) { if (t === 4) throw e; await sleep(2000 * (t + 1)); }
  }
}
const cached = async (name, fn) => {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 24 * 3600e3) return JSON.parse(fs.readFileSync(f));
  const v = await fn(); fs.writeFileSync(f, JSON.stringify(v)); return v;
};
const bars4 = sym => cached(`${sym}-4h.json`, async () => {
  const out = [], now = Date.now();
  let start = FROM;
  while (start < now) {
    const rows = await json(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=4h&limit=1500&startTime=${start}`);
    if (!rows.length) break;
    for (const x of rows) if (x[6] < now) out.push({ t: x[0] / 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], tb: +x[9] });
    start = rows.at(-1)[0] + 1;
    await sleep(200);
  }
  return out;
});
const funding = sym => cached(`${sym}-fund.json`, async () => {
  const out = [];
  let start = FROM;
  for (let k = 0; k < 10; k++) {
    const rows = await json(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1000&startTime=${start}`);
    if (!rows.length) break;
    out.push(...rows.map(x => ({ t: x.fundingTime / 1000, f: +x.fundingRate })));
    if (rows.length < 1000) break;
    start = rows.at(-1).fundingTime + 1;
    await sleep(200);
  }
  return out;
});
const duka4 = inst => cached(`${inst.replace('/', '')}-4h.json`, async () => {
  const out = new Map();
  let ts = Date.now();
  while (ts > FROM) {
    const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=' + encodeURIComponent(inst) +
      `&offer_side=B&interval=4HOUR&splits=true&stocks=true&limit=1000&time_direction=P&timestamp=${ts}&jsonp=_cb`;
    const body = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' } })).text();
    const rows = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))).filter(Boolean);
    if (!rows.length) break;
    for (const x of rows) out.set(x[0] / 1000, { t: x[0] / 1000, o: x[1], h: x[2], l: x[3], c: x[4], v: x[5], tb: null });
    ts = Math.min(...rows.map(x => x[0])) - 1;
  }
  return [...out.values()].sort((a, b) => a.t - b.t).filter(b => b.t * 1000 >= FROM && b.t + 14400 <= Date.now() / 1000);
});

const atrS = (b, n = 14) => {
  const out = []; let a = null;
  for (let i = 0; i < b.length; i++) {
    const tr = i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
    a = a == null ? tr : (a * (n - 1) + tr) / n; out.push(a);
  }
  return out;
};
const rsiS = (c, n = 14) => {
  const out = Array(c.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};
function roll(b, sec) {
  const out = [];
  for (const x of b) {
    const t = x.t - x.t % sec, last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, x.h); last.l = Math.min(last.l, x.l); last.c = x.c; last.v += x.v; last.end = x.t + 14400; }
    else out.push({ t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, end: x.t + 14400 });
  }
  return out;
}
const trendOf = (c, e20, e50, j) => j < 55 ? 0 : e20[j] > e50[j] && c[j] > e50[j] && e20[j] > e20[j - 3] ? 1 : e20[j] < e50[j] && c[j] < e50[j] && e20[j] < e20[j - 3] ? -1 : 0;

// daily series + index of the last CLOSED day for each 4H bar
function dailyCtx(b) {
  const d = roll(b, 86400), dc = d.map(x => x.c), de20 = ema(dc, 20), de50 = ema(dc, 50), de200 = ema(dc, 200), dA = atrS(d), dr = rsiS(dc);
  const dt = dc.map((_, j) => trendOf(dc, de20, de50, j));
  const w = roll(b, 604800), wc = w.map(x => x.c), we10 = ema(wc, 10), we20 = ema(wc, 20);
  const idx = [], widx = [];
  let j = -1, k = -1;
  for (const x of b) {
    const now = x.t + 14400;
    while (j + 1 < d.length && d[j + 1].t + 86400 <= now) j++;
    while (k + 1 < w.length && w[k + 1].t + 604800 <= now) k++;
    idx.push(j); widx.push(k);
  }
  return { d, dc, de20, de50, de200, dA, dr, dt, idx, widx, wt: k => k < 20 ? 0 : we10[k] > we20[k] ? 1 : -1 };
}

function walk(b, i, dir, stop, maxBars, e20_4, costPerDay, fixedFee) {
  const entry = b[i].c, dist = Math.abs(entry - stop), res = {};
  let tr = null, trSl = stop, n = 0;
  for (let k = i + 1; k < Math.min(b.length, i + 1 + maxBars); k++) {
    const x = b[k]; n = k - i;
    const best = ((dir > 0 ? x.h : x.l) - entry) * dir / dist, worst = ((dir > 0 ? x.l : x.h) - entry) * dir / dist;
    for (const tp of [1, 1.5, 2, 3]) if (res[tp] == null) { if (worst <= -1) res[tp] = { r: -1, n }; else if (best >= tp) res[tp] = { r: tp, n }; }
    if (tr == null) {
      if ((dir > 0 ? x.l <= trSl : x.h >= trSl)) tr = { r: (trSl - entry) * dir / dist, n };
      else {
        if (best >= 1) trSl = dir > 0 ? Math.max(trSl, entry) : Math.min(trSl, entry);
        if (best >= 1 && (x.c - e20_4[k]) * dir < 0) tr = { r: (x.c - entry) * dir / dist, n };
      }
    }
    if (tr && [1, 1.5, 2, 3].every(tp => res[tp])) break;
  }
  const last = b[Math.min(b.length - 1, i + maxBars)], mtm = (last.c - entry) * dir / dist;
  const r = {};
  for (const tp of [1, 1.5, 2, 3]) { const o = res[tp] ?? { r: Math.max(-1, Math.min(tp, mtm)), n }; r[tp] = +(o.r - fixedFee / dist - costPerDay * o.n / 6 / dist).toFixed(3); }
  const o = tr ?? { r: Math.max(-1, mtm), n };
  r.trail = +(o.r - fixedFee / dist - costPerDay * o.n / 6 / dist).toFixed(3);
  return { r, bars: n };
}

function events(m, b, fund, btcCtx) {
  const D = dailyCtx(b), c = b.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), A4 = atrS(b);
  const out = [], busy = {};
  let fp = 0;
  for (let i = 60; i < b.length - 1; i++) {
    const j = D.idx[i]; if (j < 60) continue;
    const x = b[i], now = x.t + 14400, dir0 = D.dt[j];
    while (fp < fund.length - 1 && fund[fp + 1].t <= now) fp++;
    const dayClose = (x.t + 14400) % 86400 === 0;       // this 4H bar closes the UTC day
    const cands = [];
    for (const d of [1, -1]) {
      if (dayClose) {
        const hi20 = Math.max(...D.d.slice(j - 20, j).map(y => y.h)), lo20 = Math.min(...D.d.slice(j - 20, j).map(y => y.l));
        if (d > 0 ? D.dc[j] > hi20 : D.dc[j] < lo20) cands.push({ k: 'dbreak', d, stop: x.c - d * 2 * D.dA[j], max: 180 });
        if (D.dt[j] === d && D.dt[j - 1] !== d) cands.push({ k: 'dflip', d, stop: x.c - d * 2 * D.dA[j], max: 180 });
      }
      if (dir0 === d) {
        const touched = b.slice(i - 2, i + 1).some(y => d > 0 ? y.l <= e20[i] + 0.3 * A4[i] : y.h >= e20[i] - 0.3 * A4[i]);
        const rng = x.h - x.l || 1e-12, body = (x.c - x.o) * d;
        if (touched && body > 0 && body / rng >= 0.5 && (d > 0 ? x.c > b[i - 1].h : x.c < b[i - 1].l) && (x.c - e20[i]) * d > 0) {
          let s = d > 0 ? Math.min(...b.slice(i - 2, i + 1).map(y => y.l)) - 0.2 * A4[i] : Math.max(...b.slice(i - 2, i + 1).map(y => y.h)) + 0.2 * A4[i];
          const dist = Math.min(Math.max(Math.abs(x.c - s), A4[i]), 3 * A4[i]); s = x.c - d * dist;
          cands.push({ k: 'pb4', d, stop: s, max: 60 });
        }
      }
    }
    for (const cd of cands) {
      const key = cd.k + cd.d; if (busy[key] > i) continue;
      const d = cd.d, dist = Math.abs(x.c - cd.stop);
      const fixedFee = m.cls === 'crypto' ? x.c * 0.001 : m.cls === 'gold' ? 0.4 : m.pip * 1.2, perDay = m.cls === 'crypto' ? x.c * 0.0003 : m.cls === 'gold' ? 0.15 : m.pip * 0.3;
      const w = walk(b, i, d, cd.stop, cd.max, e20, perDay, fixedFee);
      busy[key] = i + Math.max(1, w.bars);
      const volAvg = b.slice(i - 30, i).reduce((s, y) => s + y.v, 0) / 30;
      let flow = 0;
      if (x.tb != null) { let tb = 0, v = 0; for (let k = i - 5; k <= i; k++) { tb += b[k].tb; v += b[k].v; } flow = v ? tb / v - 0.5 : 0; }
      const fr = fund.length ? fund.slice(Math.max(0, fp - 8), fp + 1).reduce((s, f) => s + f.f, 0) / Math.min(9, fp + 1) : 0;
      const bj = btcCtx ? btcCtx.byT.get(x.t) : null;
      const ext = (x.c - D.de20[j]) * d / D.dA[j];
      out.push({
        id: m.id, cls: m.cls, t: x.t, k: cd.k, d, ...w,
        conf: {
          week: D.wt(D.widx[i]) * d,
          dtrend: D.dt[j] * d,
          ema200: D.de200[j] && j >= 200 ? Math.sign((x.c - D.de200[j]) * d) : 0,
          btc: m.cls === 'crypto' && m.id !== 'BTCUSDT' && bj != null ? bj * d : 0,
          vol: x.v > 1.5 * volAvg ? 1 : 0,
          flow: x.tb == null ? 0 : flow * d > 0.02 ? 1 : flow * d < -0.02 ? -1 : 0,
          funding: m.cls !== 'crypto' ? 0 : d > 0 ? (fr < 0 ? 1 : fr > 0.0002 ? -1 : 0) : (fr > 0.0002 ? 1 : fr < 0 ? -1 : 0),
          rsi: d > 0 ? (D.dr[j] > 75 ? -1 : D.dr[j] < 55 ? 1 : 0) : (D.dr[j] < 25 ? -1 : D.dr[j] > 45 ? 1 : 0),
          ext: ext > 3 ? -1 : ext < 1.5 ? 1 : 0
        }
      });
    }
  }
  return out;
}

// ─── run ───
const info = await json('https://fapi.binance.com/fapi/v1/ticker/24hr');
const perps = new Set((await json('https://fapi.binance.com/fapi/v1/exchangeInfo')).symbols
  .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => s.symbol));
const coins = info.filter(t => perps.has(t.symbol) && !/^(USDC|FDUSD|XAU|XAG|PAXG)/.test(t.symbol))
  .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, TOP).map(t => t.symbol);
if (!coins.includes('BTCUSDT')) coins.unshift('BTCUSDT');

const btcB = await bars4('BTCUSDT'), btcD = dailyCtx(btcB);
const btcCtx = { byT: new Map(btcB.map((x, i) => [x.t, btcD.idx[i] >= 0 ? btcD.dt[btcD.idx[i]] : 0])) };
let E = [];
if (process.argv.includes('--fx')) {
  for (const id of ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDJPY', 'USDCAD', 'USDCHF']) {
    const b = await duka4(`${id.slice(0, 3)}/${id.slice(3)}`);
    console.error(`${id} ${b.length} bars`);
    E.push(...events({ id, cls: 'forex', pip: id.includes('JPY') ? 0.01 : 0.0001 }, b, [], null));
  }
} else {
try { const g = await duka4('XAU/USD'); console.error(`gold ${g.length} bars from ${new Date(g[0].t * 1000).toISOString().slice(0, 10)}`); E.push(...events({ id: 'XAUUSD', cls: 'gold' }, g, [], null)); }
catch (e) { console.error('gold failed', e.message); }
for (const [k, s] of coins.entries()) {
  try { const [b, f] = await Promise.all([bars4(s), funding(s)]); if (b.length > 600) E.push(...events({ id: s, cls: 'crypto' }, b, f, btcCtx)); }
  catch (e) { console.error(s, e.message); }
  if ((k + 1) % 10 === 0) console.error(`${k + 1}/${coins.length} coins, ${E.length} events`);
}
}
fs.writeFileSync(path.join(CACHE, 'events.json'), JSON.stringify(E));

// ─── analysis ───
const part = e => e.t >= EXAM ? 'exam' : e.t >= CHECK ? 'check' : 'pick';
const P = { pick: [], check: [], exam: [] }; for (const e of E) P[part(e)].push(e);
const stat = (es, tp) => {
  if (!es.length) return { n: 0 };
  const r = es.map(e => e.r[tp]), avg = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - avg) ** 2, 0) / r.length);
  return { n: r.length, wr: r.filter(v => v > 0).length / r.length * 100, avg, lb: avg - 1.5 * sd / Math.sqrt(r.length) };
};
const fmt = s => s.n ? `${String(s.n).padStart(5)} ${s.wr.toFixed(0).padStart(3)}% ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)}R` : '      –          ';
console.log(`${E.length} events · pick ${P.pick.length} (to 2024-06) · check ${P.check.length} (to 2025-08) · exam ${P.exam.length} (last 12 mo)`);
const ks = [...new Set(E.map(e => e.k))];
for (const cls of [...new Set(E.map(e => e.cls))]) {
  console.log(`\n1. ${cls.toUpperCase()} — each setup alone: pick | check | exam`);
  for (const k of ks) for (const tp of TPS) {
    const f = p => stat(P[p].filter(e => e.cls === cls && e.k === k), tp);
    console.log(`  ${k.padEnd(7)} ${tp.padStart(5)} | ${fmt(f('pick'))} | ${fmt(f('check'))} | ${fmt(f('exam'))}`);
  }
}
const FEATS = Object.keys(E[0].conf);
console.log('\n2. CONFLUENCE (crypto+gold, trail exit): avg R when AGREES / NEUTRAL / OPPOSES — pick | check');
for (const f of FEATS) {
  const row = p => [1, 0, -1].map(v => { const s = stat(P[p].filter(e => e.conf[f] === v), 'trail'); return s.n >= 30 ? `${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(2)}(${s.n})` : '    –    '; }).join(' ');
  console.log(`  ${f.padEnd(8)} ${row('pick')} | ${row('check')}`);
}
// score with weights from PICK only, threshold chosen on CHECK, EXAM once
const w = {};
for (const f of FEATS) { const a = stat(P.pick.filter(e => e.conf[f] === 1), 'trail'), o = stat(P.pick.filter(e => e.conf[f] !== 1), 'trail'); w[f] = a.n >= 40 && o.n >= 40 && Math.abs(a.avg - o.avg) > 0.05 ? Math.sign(a.avg - o.avg) : 0; }
const score = e => FEATS.reduce((s, f) => s + w[f] * e.conf[f], 0);
console.log(`\n3. "HIGHLY CONFIRMED" SCORE, weights from PICK: ${FEATS.filter(f => w[f]).map(f => (w[f] > 0 ? '+' : '-') + f).join(' ') || '(none)'}`);
for (const k of [...ks, 'any']) for (const tp of TPS) for (const th of [0, 2, 3, 4, 5]) {
  const f = p => stat(P[p].filter(e => (k === 'any' || e.k === k) && score(e) >= th), tp);
  const a = f('pick'), b = f('check');
  if (a.n >= 40 && a.avg > 0 && b.n >= 20 && b.avg > 0) console.log(`  ${k.padEnd(7)} ${tp.padStart(5)} score≥${th} | ${fmt(a)} | ${fmt(b)} | EXAM ${fmt(f('exam'))}`);
}
