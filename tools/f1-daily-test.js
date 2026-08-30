#!/usr/bin/env node
// The original F1 alarm idea, tested as a daily routine rather than a snapshot.
//
// Each morning: rank coins by how much they have been moving and whether the
// strategy has been paying on them lately, take the top few, and trade only
// those for the day — and only while the coin is actually volatile.
//
// Everything is decided from data available BEFORE the day starts. A screener
// that picks yesterday's winners using yesterday's results is just reading the
// answer sheet, and that is the mistake this is built to avoid.

import '../src/env.js';
import fs from 'fs';
import { fetchCandlesDeep } from '../src/providers.js';
import { analyze } from '../src/strategy.js';
import { universe } from '../src/ignition.js';
import { maxLev, hydrate } from '../src/leverage.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch {}
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const TF = flag('tf', '5m'), COINS = +flag('coins', 40), DAYS = +flag('days', 21);
const PICK = +flag('pick', 5), MINVOL = +flag('minvol', 0);
const PER_DAY = TF === '3m' ? 480 : TF === '5m' ? 288 : 96;
const DAY = 864e5;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

let board;
try { board = (await universe('futures', 2e7)).sort((a,b) => b.quoteVol - a.quoteVol).slice(0, COINS); }
catch { board = JSON.parse(fs.readFileSync('data/universe-cache.json','utf8')).rows.slice(0, COINS); }
process.stderr.write(`[f1] ${board.length} coins · ${TF} · ${DAYS}d\n`);

const bars = Math.min(9000, DAYS * PER_DAY + 400);
const data = await mapLimit(board, 5, async (row) => {
  const c = await fetchCandlesDeep('futures', row.symbol, TF, bars);
  if (c.length < 500) return null;
  const a = analyze(c);
  if (!a) return null;
  return { symbol: row.symbol, candles: c, trades: a.trades, lev: maxLev('futures', row.symbol) || 1 };
});
const coins = data.filter(Boolean);

// Daily range % per coin, used both to rank and to gate entries.
const dayVol = (c, from, to) => {
  const w = c.filter(b => b.t >= from && b.t < to);
  if (!w.length) return 0;
  const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
  return lo > 0 ? (hi - lo) / lo * 100 : 0;
};

const end = Math.max(...coins.map(c => c.candles.at(-1).t));
const start = end - DAYS * DAY;
const rows = [];

for (let d = start + 3 * DAY; d < end; d += DAY) {
  // Rank on the three days BEFORE this one only.
  const ranked = coins.map(c => {
    const vol = (dayVol(c.candles, d - 3*DAY, d - 2*DAY) + dayVol(c.candles, d - 2*DAY, d - DAY) + dayVol(c.candles, d - DAY, d)) / 3;
    const recent = c.trades.filter(t => t.exitTime >= d - 7*DAY && t.exitTime < d);
    const pnl = recent.reduce((s, t) => s + t.pnlPct, 0);
    return { c, vol, pnl, n: recent.length };
  }).filter(x => x.n >= 3 && x.pnl > 0)          // "profitable lately", judged before the day
    .sort((a, b) => b.vol - a.vol)                // then most volatile
    .slice(0, PICK);

  for (const { c } of ranked) {
    for (const t of c.trades) {
      if (t.entryTime < d || t.entryTime >= d + DAY) continue;
      if (MINVOL > 0) {                            // only trade while it is actually moving
        const i = c.candles.findIndex(b => b.t === t.entryTime);
        const w = c.candles.slice(Math.max(0, i - Math.round(PER_DAY/24)), i);
        if (!w.length) continue;
        const hi = Math.max(...w.map(b=>b.h)), lo = Math.min(...w.map(b=>b.l));
        if ((hi - lo) / lo * 100 < MINVOL) continue;
      }
      rows.push({ day: d, symbol: c.symbol, pnl: t.pnlPct, r: t.r, lev: c.lev, side: t.side });
    }
  }
}

// A trade cannot lose more than its margin, and at leverage the stop may sit
// beyond the liquidation distance — so floor every result at -100%.
const at = (r, L) => { const l = Math.min(L, r.lev); return Math.max(r.pnl * l, -100); };
const sum = a => a.reduce((s,v) => s+v, 0);
const days = [...new Set(rows.map(r => r.day))].length;
console.log(`\n${TF} · picked top ${PICK} by volatility among coins the strategy was already paying on`);
console.log(`${rows.length} trades over ${days} trading days · ${(rows.length/Math.max(days,1)).toFixed(1)}/day\n`);
console.log('  ' + 'leverage'.padEnd(11) + 'win'.padStart(6) + 'avg/trade'.padStart(12) + 'total'.padStart(11) + '   $100 becomes' + '   $1/trade'.padStart(14));
for (const L of [1, 5, 10, 25]) {
  const v = rows.map(r => at(r, L));
  // 1% of the wallet per trade, compounded in order.
  let bal = 100;
  for (const r of rows.sort((a,b)=>a.day-b.day)) bal += Math.max(bal*0.01*at(r,L)/100, -bal*0.01);
  // Flat $1 a trade — no compounding, so the number is just the edge times the
  // number of trades, and a losing trade can only ever cost the $1.
  const flat = sum(rows.map(r => Math.max(at(r, L), -100) / 100));
  console.log('  ' + (L===1?'spot (1x)':L+'x').padEnd(11) +
    ((rows.filter(r=>r.pnl>0).length/rows.length*100).toFixed(0)+'%').padStart(6) +
    ((sum(v)/v.length>=0?'+':'')+(sum(v)/v.length).toFixed(2)+'%').padStart(12) +
    ((sum(v)>=0?'+':'')+sum(v).toFixed(0)+'%').padStart(11) +
    ('$'+bal.toFixed(2)).padStart(16) +
    ((flat>=0?'+$':'-$')+Math.abs(flat).toFixed(2)).padStart(14));
}
