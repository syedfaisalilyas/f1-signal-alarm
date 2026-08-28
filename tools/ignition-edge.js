#!/usr/bin/env node
// Which ignitions were worth taking?
//
// Every trade carries what its trigger candle looked like: volume against
// average, range against ATR, and how tight the coil it left was. If the big
// winners share a signature the losers lack, the filter writes itself. If they
// don't, that is worth knowing too — it means the tail cannot be selected for
// and the only lever left is position size.

import fs from 'fs';
import { maxLev, hydrate } from '../src/leverage.js';
import { simulateTrail } from '../src/ignition.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch { /* defaults */ }

const TF_MS = { '5m': 300000, '15m': 900000, '1h': 3600000 };
const W = JSON.parse(fs.readFileSync('data/ignition-windows.json', 'utf8'));
const L = JSON.parse(fs.readFileSync('data/ignition-leaderboard.json', 'utf8')).rows;

// The leaderboard rows hold the trigger's shape; the windows hold the bars.
// They key on the same trade: a window's entry is one bar after the signal.
const feat = new Map();
for (const r of L) feat.set(`${r.symbol}|${r.interval}|${r.time + TF_MS[r.interval]}`, r);

const trades = [];
for (const w of W) {
  const f = feat.get(`${w.symbol}|${w.interval}|${w.entryTime}`);
  if (!f) continue;
  const o = simulateTrail(w.bars.map(([t, h, l, c]) => ({ t, h, l, c, o: c })),
    { bar: -1, side: w.side, stop: w.stop, tp1: w.tp1, tp2: w.tp2 });
  if (!o) continue;
  const lev = maxLev('futures', w.symbol) || 1;
  const dead = o.dipPct >= 100 / lev;
  trades.push({
    symbol: w.symbol, interval: w.interval, side: w.side,
    volX: f.volX, rangeX: f.rangeX, coilPct: f.coilPct, power: f.volX * f.rangeX,
    pnl: o.pnlPct, peak: o.peakPct, dip: o.dipPct,
    at10: o.dipPct >= 10 ? -100 : o.pnlPct * 10,
    atMax: dead ? -100 : o.pnlPct * lev
  });
}

const sum = a => a.reduce((s, v) => s + v, 0);
const avg = a => a.length ? sum(a) / a.length : 0;
const pad = (s, n) => String(s).padEnd(n);
const pct = (v, n = 7) => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(n);

console.log(`\n${trades.length} trades matched to their trigger shape\n`);

function bucketBy(name, get, edges) {
  console.log(`\n  ── ${name} ──`);
  console.log(`  ${pad('band', 16)}${'n'.padStart(6)}${'win'.padStart(6)}` +
    `${'avg 10x'.padStart(10)}${'avg max'.padStart(10)}${'share of profit'.padStart(17)}`);
  const total = sum(trades.filter(t => t.atMax > 0).map(t => t.atMax));
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const b = trades.filter(t => get(t) >= lo && get(t) < hi);
    if (!b.length) continue;
    const profit = sum(b.filter(t => t.atMax > 0).map(t => t.atMax));
    console.log(`  ${pad(`${lo}–${hi === Infinity ? '∞' : hi}`, 16)}${String(b.length).padStart(6)}` +
      `${((b.filter(t => t.pnl > 0).length / b.length * 100).toFixed(0) + '%').padStart(6)}` +
      `${pct(avg(b.map(t => t.at10)), 10)}${pct(avg(b.map(t => t.atMax)), 10)}` +
      `${((profit / total * 100).toFixed(0) + '%').padStart(17)}`);
  }
}

bucketBy('volume vs its 20-bar average', t => t.volX, [0, 3, 5, 8, 15, 30, Infinity]);
bucketBy('candle range in ATR', t => t.rangeX, [0, 2.5, 3.5, 5, 8, Infinity]);
bucketBy('how tight the coil was (% wide)', t => t.coilPct, [0, 1, 2, 3, 5, 10, Infinity]);
bucketBy('power (range × volume)', t => t.power, [0, 10, 20, 40, 80, Infinity]);

console.log(`\n  ── direction ──`);
for (const s of ['LONG', 'SHORT']) {
  const b = trades.filter(t => t.side === s);
  console.log(`  ${pad(s, 16)}${String(b.length).padStart(6)}` +
    `${((b.filter(t => t.pnl > 0).length / b.length * 100).toFixed(0) + '%').padStart(6)}` +
    `${pct(avg(b.map(t => t.at10)), 10)}${pct(avg(b.map(t => t.atMax)), 10)}`);
}

// Where does the money actually come from?
const winners = [...trades].sort((a, b) => b.atMax - a.atMax);
const topN = Math.ceil(trades.length * 0.05);
const top = winners.slice(0, topN);
const totalProfit = sum(trades.filter(t => t.atMax > 0).map(t => t.atMax));
console.log(`\n  ── concentration ──`);
console.log(`  the best ${topN} trades (${(topN / trades.length * 100).toFixed(0)}%) carry ` +
  `${(sum(top.map(t => t.atMax)) / totalProfit * 100).toFixed(0)}% of all profit`);
console.log(`  their median volume ${(top.map(t => t.volX).sort((a, b) => a - b)[Math.floor(top.length / 2)]).toFixed(1)}× ` +
  `vs ${(trades.map(t => t.volX).sort((a, b) => a - b)[Math.floor(trades.length / 2)]).toFixed(1)}× for all trades`);
console.log(`  their median coil ${(top.map(t => t.coilPct).sort((a, b) => a - b)[Math.floor(top.length / 2)]).toFixed(2)}% ` +
  `vs ${(trades.map(t => t.coilPct).sort((a, b) => a - b)[Math.floor(trades.length / 2)]).toFixed(2)}% for all trades`);
console.log(`  their median range ${(top.map(t => t.rangeX).sort((a, b) => a - b)[Math.floor(top.length / 2)]).toFixed(1)}×ATR ` +
  `vs ${(trades.map(t => t.rangeX).sort((a, b) => a - b)[Math.floor(trades.length / 2)]).toFixed(1)}×ATR for all trades`);

// ── do the bad bands cost anything to remove? ──
// The tail is what pays, so a filter is only worth taking if it keeps the tail.
// Retained profit is the column that decides, not win rate.
const base = { n: trades.length, profit: sum(trades.filter(t => t.atMax > 0).map(t => t.atMax)) };
const FILTERS = {
  'everything (baseline)':        () => true,
  'drop range < 2.5 ATR':         t => t.rangeX >= 2.5,
  'drop coil wider than 5%':      t => t.coilPct <= 5,
  'longs only':                   t => t.side === 'LONG',
  'volume 30x+ only':             t => t.volX >= 30,
  'longs + range 2.5 + coil 5':   t => t.side === 'LONG' && t.rangeX >= 2.5 && t.coilPct <= 5,
  'that, plus volume 5x+':        t => t.side === 'LONG' && t.rangeX >= 2.5 && t.coilPct <= 5 && t.volX >= 5,
  'that, plus 1h only':           t => t.side === 'LONG' && t.rangeX >= 2.5 && t.coilPct <= 5 && t.volX >= 5 && t.interval === '1h'
};
console.log(`\n\n  ── what filtering costs and buys ──`);
console.log(`  ${pad('filter', 30)}${'trades'.padStart(8)}${'win'.padStart(6)}` +
  `${'avg 10x'.padStart(10)}${'avg max'.padStart(10)}${'profit kept'.padStart(13)}`);
for (const [name, f] of Object.entries(FILTERS)) {
  const b = trades.filter(f);
  if (!b.length) continue;
  const profit = sum(b.filter(t => t.atMax > 0).map(t => t.atMax));
  console.log(`  ${pad(name, 30)}${String(b.length).padStart(8)}` +
    `${((b.filter(t => t.pnl > 0).length / b.length * 100).toFixed(0) + '%').padStart(6)}` +
    `${pct(avg(b.map(t => t.at10)), 10)}${pct(avg(b.map(t => t.atMax)), 10)}` +
    `${((profit / base.profit * 100).toFixed(0) + '%').padStart(13)}`);
}
