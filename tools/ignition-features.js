#!/usr/bin/env node
// A harder look for the difference between winners and losers.
//
// The first pass only ever saw the trigger candle. This one collects what the
// coin looked like BEFORE it fired — how long it had been dead, whether it was
// breaking to a genuine new high or just rattling inside an old range, what its
// last week and month had done, how volatile it was — plus what Bitcoin was
// doing at that hour, since a market-wide bid lifts everything.
//
// Validation is a time split on the SAME timeframe: rules are found in the
// older half and scored on the newer half they never saw. Comparing 1h rules
// against 5m was never a fair test — those are different markets, not held-out
// data.

import '../src/env.js';
import fs from 'fs';
import { fetchCandlesDeep } from '../src/providers.js';
import { ignitionEvents, simulateTrail, universe } from '../src/ignition.js';
import { maxLev, hydrate } from '../src/leverage.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch { /* defaults */ }

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const INTERVAL = flag('interval', '1h');
const COINS = +flag('coins', 100);
const BARS = +flag('bars', 2200);
const PER_DAY = INTERVAL === '1h' ? 24 : INTERVAL === '15m' ? 96 : 288;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

// Bitcoin at each hour, so every signal can be scored against the tide.
const btc = await fetchCandlesDeep('futures', 'BTCUSDT', INTERVAL, BARS);
const btcAt = new Map(btc.map((b, i) => [b.t, i]));
const btcRet = (t, back) => {
  const i = btcAt.get(t); if (i == null || i < back) return null;
  return (btc[i].c - btc[i - back].c) / btc[i - back].c * 100;
};

let board;
try { board = (await universe('futures', 3e6)).sort((a, b) => b.quoteVol - a.quoteVol).slice(0, COINS); }
catch {
  const c = JSON.parse(fs.readFileSync('data/universe-cache.json', 'utf8'));
  board = c.rows.slice(0, COINS);
  process.stderr.write('[board] using cached universe\n');
}
process.stderr.write(`[features] ${board.length} coins × ${BARS} bars on ${INTERVAL}…\n`);

const rows = [];
await mapLimit(board, 5, async (row) => {
  const c = await fetchCandlesDeep('futures', row.symbol, INTERVAL, BARS);
  if (c.length < 400) return;
  const lev = maxLev('futures', row.symbol) || 1;
  for (const ev of ignitionEvents(c)) {
    const i = ev.bar;
    if (i < 30 * PER_DAY || i + 2 >= c.length) continue;      // need a month of runway behind it
    const o = simulateTrail(c, ev);
    if (!o) continue;

    const look = n => c.slice(Math.max(0, i - n), i);
    const hi30 = Math.max(...look(30 * PER_DAY).map(b => b.h));
    const ret = n => { const p = c[i - n]?.c; return p ? (c[i].c - p) / p * 100 : null; };
    const atr = look(14).reduce((s, b) => s + (b.h - b.l), 0) / 14;

    rows.push({
      symbol: row.symbol, t: c[i + 1].t, side: ev.side, lev,
      // trigger shape (already known)
      volX: ev.volX, rangeX: ev.rangeX, coilPct: ev.boxWidthPct,
      // NEW: what the coin looked like before it fired
      coilBars: ev.coilBars,
      newHigh: hi30 > 0 ? (c[i].c - hi30) / hi30 * 100 : null,   // >0 = real 30-day breakout
      ret7d: ret(7 * PER_DAY), ret30d: ret(30 * PER_DAY),
      atrPct: c[i].c > 0 ? atr / c[i].c * 100 : null,
      // NEW: the tide
      btc24: btcRet(c[i].t, PER_DAY), btc7d: btcRet(c[i].t, 7 * PER_DAY),
      // outcome
      pnlPct: o.pnlPct, peakPct: o.peakPct, dipPct: o.dipPct,
      // when it closed, so overlapping trades can be modelled honestly
      exitTime: o.exitTime
    });
  }
});

rows.sort((a, b) => a.t - b.t);
fs.writeFileSync('data/ignition-features.json', JSON.stringify(rows));
console.log(`${rows.length} ignitions with full features → data/ignition-features.json`);
console.log(`span ${new Date(rows[0].t).toISOString().slice(0, 10)} → ${new Date(rows.at(-1).t).toISOString().slice(0, 10)}`);
