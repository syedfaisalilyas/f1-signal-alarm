#!/usr/bin/env node
// Run the "best suitable coins" screener once per day for a month, and add up
// what each day's shortlist made.
//
// Two rankings, reported side by side, because the difference is the whole
// question:
//
//   SAME-DAY  ranks coins by the volatility of the day being traded. That is
//             what the screener shows you, and it is not tradeable — on the
//             morning of the 14th nobody knows the 14th was volatile.
//   PRIOR-DAY ranks by yesterday, which is what you could actually have acted
//             on at the open.
//
// Cross margin is assumed: the wallet is far larger than total notional, so
// nothing liquidates and every trade runs to its own stop. $1 of margin at
// 100x is a $100 position.

import '../src/env.js';
import fs from 'fs';
import { fetchCandlesDeep } from '../src/providers.js';
import { analyze } from '../src/strategy.js';
import { universe } from '../src/ignition.js';
import { maxLev, hydrate } from '../src/leverage.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch {}
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const TF = flag('tf', '5m'), POOL = +flag('pool', 60), PICK = +flag('pick', 10), DAYS = +flag('days', 30);
const DAY = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

let board;
try { board = (await universe('futures', 5e6)).sort((a,b) => b.quoteVol - a.quoteVol).slice(0, POOL); }
catch { board = JSON.parse(fs.readFileSync('data/universe-cache.json','utf8')).rows.slice(0, POOL); }
process.stderr.write(`[daily] ${board.length} coins · ${TF} · ${DAYS} days\n`);

const coins = (await mapLimit(board, 4, async (row) => {
  let c = null;
  for (let i = 0; i < 4 && !c; i++) { try { c = await fetchCandlesDeep('futures', row.symbol, TF, 9000); } catch { await sleep(6000); } }
  if (!c || c.length < 2000) return null;
  const a = analyze(c);
  if (!a) return null;
  await sleep(300);
  return { symbol: row.symbol, candles: c, trades: a.trades, lev: maxLev('futures', row.symbol) || 1 };
})).filter(Boolean);
process.stderr.write(`[daily] ${coins.length} usable\n`);

const rangeOn = (c, from) => {
  const w = c.filter(b => b.t >= from && b.t < from + DAY);
  if (!w.length) return null;
  const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
  return lo > 0 ? (hi - lo) / lo * 100 : null;
};

const end = Math.floor(Math.max(...coins.map(c => c.candles.at(-1).t)) / DAY) * DAY;
const rows = [];
for (let d = end - DAYS * DAY; d < end; d += DAY) {
  const scored = coins.map(c => ({
    c, today: rangeOn(c.candles, d), prior: rangeOn(c.candles, d - DAY)
  })).filter(x => x.today !== null && x.prior !== null);
  if (scored.length < PICK) continue;

  const dayPnl = (list) => {
    let usd = 0, n = 0, coinsUsed = 0;
    for (const { c } of list) {
      const t = c.trades.filter(t => t.exitTime >= d && t.exitTime < d + DAY);
      if (!t.length) continue;
      coinsUsed++; n += t.length;
      usd += t.reduce((s, x) => s + x.pnlPct * c.lev, 0) / 100;   // $1 margin at max lev
    }
    return { usd, n, coinsUsed };
  };

  const sameDay = dayPnl([...scored].sort((a,b) => b.today - a.today).slice(0, PICK));
  const priorDay = dayPnl([...scored].sort((a,b) => b.prior - a.prior).slice(0, PICK));
  rows.push({ d, sameDay, priorDay });
}

const iso = t => new Date(t).toISOString().slice(5,10);
console.log(`\ntop ${PICK} of ${coins.length} coins, re-picked every day · ${TF} · $1 margin per trade at MEXC max\n`);
console.log('  date    trades   picked by THAT day      picked by the DAY BEFORE');
let a = 0, b = 0;
for (const r of rows) {
  a += r.sameDay.usd; b += r.priorDay.usd;
  console.log(`  ${iso(r.d)}  ${String(r.sameDay.n).padStart(6)}   ` +
    `${(r.sameDay.usd>=0?'+$':'-$')+Math.abs(r.sameDay.usd).toFixed(2)}`.padStart(12) +
    `   running ${(a>=0?'+$':'-$')+Math.abs(a).toFixed(2)}`.padStart(20) +
    `   ${(r.priorDay.usd>=0?'+$':'-$')+Math.abs(r.priorDay.usd).toFixed(2)}`.padStart(11) +
    `   running ${(b>=0?'+$':'-$')+Math.abs(b).toFixed(2)}`.padStart(20));
}
const days = rows.length, stake = PICK;
console.log(`\n  ${days} days · $${stake} of margin working each day`);
console.log(`  picked by that day  : ${(a>=0?'+$':'-$')}${Math.abs(a).toFixed(2)}   = ${(a/stake*100).toFixed(0)}% on the margin   ${(a/10).toFixed(1)}% of a $1000 wallet`);
console.log(`  picked by yesterday : ${(b>=0?'+$':'-$')}${Math.abs(b).toFixed(2)}   = ${(b/stake*100).toFixed(0)}% on the margin   ${(b/10).toFixed(1)}% of a $1000 wallet`);
