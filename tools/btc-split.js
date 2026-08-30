#!/usr/bin/env node
// Every scan width flipped from red to green on the same day, 12 August. That
// is the signature of a market-wide cause rather than anything about the coins
// picked. This checks it against BTC, day by day, and then asks the only
// question that matters: would refusing to trade on BTC-down days have removed
// the losing half?
//
// The filter is judged on the PREVIOUS day's BTC close, since on the morning of
// the 4th nobody knows how the 4th ends.

import '../src/env.js';
import fs from 'fs';
import { fetchCandlesDeep } from '../src/providers.js';
import { analyze } from '../src/strategy.js';
import { VolatilityScanner } from '../src/volatility.js';
import { maxLev, hydrate } from '../src/leverage.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch {}
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i+1] : d; };
const PICK = +flag('pick', 30);
const DAY = 864e5, TFS = ['1m','3m','5m'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// BTC daily closes, and its 7-day trend at each day.
const btc = await fetchCandlesDeep('futures', 'BTCUSDT', '1h', 2200);
const btcDay = new Map();
for (const b of btc) {
  const d = Math.floor(b.t / DAY) * DAY;
  const e = btcDay.get(d) || { o: b.o, c: b.c, hi: b.h, lo: b.l };
  e.c = b.c; e.hi = Math.max(e.hi, b.h); e.lo = Math.min(e.lo, b.l);
  btcDay.set(d, e);
}
const btcRet = d => { const e = btcDay.get(d); return e ? (e.c - e.o) / e.o * 100 : null; };
const btc7 = d => {
  const a = btcDay.get(d - 7*DAY), b = btcDay.get(d);
  return a && b ? (b.c - a.c) / a.c * 100 : null;
};

const board = (await new VolatilityScanner({ depth: PICK }).board('futures', [])).slice(0, PICK);
const series = [];
for (const row of board) {
  for (const tf of TFS) {
    let c = null;
    for (let i = 0; i < 4 && !c; i++) { try { c = await fetchCandlesDeep('futures', row.symbol, tf, 9000); } catch { await sleep(5000); } }
    if (!c || c.length < 300) continue;
    const a = analyze(c);
    if (a) series.push({ symbol: row.symbol, tf, trades: a.trades, lev: maxLev('futures', row.symbol) || 1, from: c[0].t });
    await sleep(200);
  }
  process.stderr.write('.');
}
process.stderr.write('\n');

const dayPnl = d => {
  const best = new Map();
  for (const s of series) {
    if (s.from > d) continue;
    const t = s.trades.filter(x => x.exitTime >= d && x.exitTime < d + DAY);
    if (!t.length) continue;
    const raw = t.reduce((a, x) => a + x.pnlPct, 0);
    const prev = best.get(s.symbol);
    if (!prev || raw * s.lev > prev) best.set(s.symbol, raw * s.lev);
  }
  return best.size ? [...best.values()].reduce((a, v) => a + v, 0) : null;
};

const start = Date.parse('2026-08-01T00:00:00Z');
const today = Math.floor(Date.now() / DAY) * DAY;
const iso = t => new Date(t).toISOString().slice(5, 10);

console.log(`\n  top ${PICK} coins · strategy result vs what BTC did\n`);
console.log('  day     BTC that day   BTC prev 7d    strategy      would the filter have traded?');
let all = 0, filtered = 0, skipped = 0, skippedSum = 0;
for (let d = start; d < today; d += DAY) {
  const p = dayPnl(d); if (p === null) continue;
  const r = btcRet(d), w = btc7(d - DAY);      // yesterday's 7-day trend
  const trade = w !== null && w > 0;
  all += p;
  if (trade) filtered += p; else { skipped++; skippedSum += p; }
  console.log(`  ${iso(d)}  ${(r>=0?'+':'')+r.toFixed(2)}%`.padEnd(22) +
    `${w===null?'  n/a':(w>=0?'+':'')+w.toFixed(1)+'%'}`.padStart(9) +
    `${(p>=0?'+':'')+Math.round(p)}%`.padStart(13) +
    `   ${trade ? 'yes' : 'NO — BTC falling'}`);
}
console.log(`\n  take every day            : ${(all>=0?'+':'')}${Math.round(all).toLocaleString()}%`);
console.log(`  only when BTC rose last 7d: ${(filtered>=0?'+':'')}${Math.round(filtered).toLocaleString()}%   (${skipped} days skipped, worth ${(skippedSum>=0?'+':'')}${Math.round(skippedSum).toLocaleString()}%)`);
