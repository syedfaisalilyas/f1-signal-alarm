#!/usr/bin/env node
// Exactly what the Best-suitable panel shows, run once per day for August.
//
// The panel picks the top N coins by CURRENT volatility, then scores those same
// coins over whatever date range you set. So this takes today's top 10, and for
// every single day of August reports the same figure the panel would: the best
// timeframe per coin, its return at MEXC max leverage, added up.
//
// Depth is the honest limit: 1m candles reach back about 6 days, 3m about 18,
// 5m about 31. Early-August days therefore have fewer timeframes to choose
// from, and the count of contributing coins is printed for each day so a thin
// day is visible rather than silently flattering.

import '../src/env.js';
import fs from 'fs';
import { fetchCandlesDeep } from '../src/providers.js';
import { analyze } from '../src/strategy.js';
import { VolatilityScanner } from '../src/volatility.js';
import { maxLev, hydrate } from '../src/leverage.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch {}
const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i+1] : d; };
const PICK = +flag('pick', 10);
// The board only gives intraday detail to its top 45 by default, so asking for
// more than that silently returns 45. Widen it to match what was asked.
const DEPTH = +flag('depth', Math.max(PICK, 45));
const TFS = ['1m', '3m', '5m'];
const DAY = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const board = (await new VolatilityScanner({ depth: DEPTH }).board('futures', [])).slice(0, PICK);
process.stderr.write(`[aug] asked ${PICK}, board returned ${board.length}\n`);

// One deep pull per coin per timeframe, then every day is computed offline.
const series = [];
for (const row of board) {
  for (const tf of TFS) {
    let c = null;
    for (let i = 0; i < 4 && !c; i++) { try { c = await fetchCandlesDeep('futures', row.symbol, tf, 9000); } catch { await sleep(6000); } }
    if (!c || c.length < 300) continue;
    const a = analyze(c);
    if (!a) continue;
    series.push({ symbol: row.symbol, tf, trades: a.trades, lev: maxLev('futures', row.symbol) || 1,
                  from: c[0].t });
    await sleep(250);
  }
  process.stderr.write('.');
}
process.stderr.write('\n');

const iso = t => new Date(t).toISOString().slice(0, 10);
const augStart = Date.parse('2026-08-01T00:00:00Z');
const today = Math.floor(Date.now() / DAY) * DAY;

console.log(`\n  each day: top ${PICK} coins, best timeframe each, return at MEXC max leverage\n`);
console.log('  day          coins   sum at MEXC max     sum at spot     top coin that day');
let total = 0, spotTotal = 0, days = 0;

for (let d = augStart; d < today; d += DAY) {
  // Best timeframe per coin for this day only.
  const best = new Map();
  for (const s of series) {
    if (s.from > d) continue;                       // candles do not reach this day
    const t = s.trades.filter(x => x.exitTime >= d && x.exitTime < d + DAY);
    if (!t.length) continue;
    const raw = t.reduce((a, x) => a + x.pnlPct, 0);
    const prev = best.get(s.symbol);
    if (!prev || raw * s.lev > prev.lev_pnl) best.set(s.symbol, { raw, lev: s.lev, tf: s.tf, lev_pnl: raw * s.lev, n: t.length });
  }
  if (!best.size) continue;
  days++;
  const rows = [...best.entries()];
  const sumLev = rows.reduce((a, [, v]) => a + v.lev_pnl, 0);
  const sumRaw = rows.reduce((a, [, v]) => a + v.raw, 0);
  total += sumLev; spotTotal += sumRaw;
  const top = rows.sort((a, b) => b[1].lev_pnl - a[1].lev_pnl)[0];
  console.log(`  ${iso(d)}  ${String(rows.length).padStart(5)}   ` +
    `${(sumLev>=0?'+':'')+Math.round(sumLev)}%`.padStart(16) +
    `${(sumRaw>=0?'+':'')+sumRaw.toFixed(1)}%`.padStart(16) +
    `   ${top[0]} ${top[1].tf} ${(top[1].lev_pnl>=0?'+':'')+Math.round(top[1].lev_pnl)}%`);
}

console.log(`\n  ${days} days with data`);
console.log(`  MONTH TOTAL at MEXC max leverage : ${(total>=0?'+':'')}${Math.round(total).toLocaleString()}%`);
console.log(`  MONTH TOTAL at spot (no leverage): ${(spotTotal>=0?'+':'')}${spotTotal.toFixed(0)}%`);
console.log(`  average day                      : ${(total/days>=0?'+':'')}${Math.round(total/days)}%`);
