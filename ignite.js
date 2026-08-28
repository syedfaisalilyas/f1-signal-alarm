#!/usr/bin/env node
// Market-wide coil watch. The watchlist scanner tells you what your setups are
// doing on coins you already chose; this asks a different question — out of
// every liquid perp on the exchange, which one just woke up?
//
//   node ignite.js                      one sweep of futures on 5m
//   node ignite.js --interval 1m        faster, noisier
//   node ignite.js --min-vol 10000000   only names with real volume
//   node ignite.js --top 15             longer coiling table
//   node ignite.js --quiet              print only, send nothing
//
// Alerts fire once per symbol per candle: state lives in cloud/ignite.json, so
// running this on a cron every minute or two does not spam the same break.

import './src/env.js';   // must be first — populates process.env from .env
import fs from 'fs';
import path from 'path';
import { fetchCandles } from './src/providers.js';
import { scanUniverse, DEFAULTS } from './src/ignition.js';
import { dispatch, initPush } from './src/notify.js';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const flag = (n, def) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const market = flag('market', 'futures');
const interval = flag('interval', '5m');
const minQuoteVol = +flag('min-vol', 3e6);
const top = +flag('top', 10);
const fresh_max = +flag('fresh', DEFAULTS.fireWindow);
const quiet = has('quiet');

const STATE = path.join(process.cwd(), 'cloud', 'ignite.json');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { fired: {} };
state.fired ||= {};

const fmt = (v, d = 6) => v === null || v === undefined ? '—' :
  Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(d);

initPush();

const t0 = Date.now();
const scan = await scanUniverse({ market, interval, minQuoteVol, fetchCandles });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n[ignite] ${scan.scanned} liquid ${market} symbols, ${scan.analysed} analysed on ${interval} in ${secs}s`);

// ─── what just went ───
// The phone only rings for a break that is still fresh. A coin that left its
// base twenty candles ago is not "from the start" any more — it stays in the
// printed list as context, but chasing it is how you end up buying the top.
const fresh = [];
for (const r of scan.igniting) {
  if (r.fired.barsAgo > fresh_max) continue;
  const key = `${r.symbol}:${interval}`;
  if (state.fired[key] === r.fired.barTime) continue;   // already alerted this candle
  state.fired[key] = r.fired.barTime;
  fresh.push(r);
}

for (const r of scan.igniting) {
  const f = r.fired;
  console.log(
    `  ${f.side === 'LONG' ? '🚀' : '🔻'} ${r.symbol.padEnd(14)} ${f.side.padEnd(5)} ` +
    `${fmt(f.price)}  range ${f.rangeX.toFixed(1)}×ATR  vol ${f.volX.toFixed(1)}×  ` +
    `out of a ${f.boxWidthPct.toFixed(1)}% coil` + (f.barsAgo ? `  (${f.barsAgo} bar ago)` : '')
  );
}
if (!scan.igniting.length) console.log('  nothing igniting right now');

// ─── what is loaded ───
console.log(`\n  coiled and ripe — the ones to have open:`);
for (const r of scan.coiling.slice(0, top)) {
  console.log(
    `  ${String(r.readiness).padStart(3)}  ${r.symbol.padEnd(14)} ${fmt(r.price)}  ` +
    `width ${r.coil.widthPct.toFixed(2)}%  tightest ${r.coil.tightRank.toFixed(0)}%  ` +
    `vol ${(r.coil.dryRatio * 100).toFixed(0)}% of normal  ` +
    `↑${fmt(r.trigger.up)} ↓${fmt(r.trigger.down)}`
  );
}
if (!scan.coiling.length) console.log('  none — the whole board is moving');

// ─── phone ───
for (const r of fresh) {
  const f = r.fired;
  const arrow = f.side === 'LONG' ? '🚀' : '🔻';
  const title = `${arrow} IGNITION ${f.side} ${r.symbol} ${interval}`;
  const body =
    `Broke a ${f.boxWidthPct.toFixed(1)}% coil (${f.coilBars} bars) at ${fmt(f.side === 'LONG' ? f.boxHi : f.boxLo)}\n` +
    `Range ${f.rangeX.toFixed(1)}× ATR · volume ${f.volX.toFixed(1)}× · body ${(f.bodyRatio * 100).toFixed(0)}%\n` +
    `Entry ${fmt(f.entry)}\n` +
    `Stop  ${fmt(f.stop)}   (${f.riskPct.toFixed(2)}%)\n` +
    `TP1   ${fmt(f.tp1)}   TP2 ${fmt(f.tp2)}   (${f.rr1.toFixed(1)}R)\n` +
    `24h volume $${(r.quoteVol / 1e6).toFixed(1)}M · ${r.changePct.toFixed(1)}% today`;

  if (quiet) { console.log(`\n[would send] ${title}\n${body}`); continue; }
  const res = await dispatch({
    title, body, priority: 5, tags: ['rocket'],
    telegram: `<b>${title}</b>\n<pre>${body}</pre>`
  }, [], () => {});
  console.log(`\n[sent] ${title} →`, JSON.stringify(res));
}

// keep the dedupe file from growing forever
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
for (const [k, t] of Object.entries(state.fired)) if (t < cutoff) delete state.fired[k];
state.at = Date.now();
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

console.log(`\n[ignite] ${fresh.length} new alert(s)\n`);
