#!/usr/bin/env node
// One-shot scan, for the scheduled runner. The live server watches candles tick
// by tick; this wakes up, looks at what closed since last time, alerts on it and
// exits. Same strategy code, same messages — only the trigger differs.
//
// Two files, deliberately: cloud/watchlist.json is configuration and lives on
// main, so editing it changes what gets scanned. cloud/state.json is runtime —
// what has already been alerted on — and is restored from the state branch each
// run. Keeping them together meant an edited watchlist was silently discarded.

import './src/env.js';   // must be first — populates process.env from .env
import fs from 'fs';
import path from 'path';
import { fetchCandles, feedSources } from './src/providers.js';
import { analyze } from './src/strategy.js';
import { buildMessage, dispatch, initPush } from './src/notify.js';
import { refresh as refreshLeverage, dump as leverageDump } from './src/leverage.js';

const DIR = path.join(process.cwd(), 'cloud');
const STATE = path.join(DIR, 'state.json');
const WATCHLIST = path.join(DIR, 'watchlist.json');
const SNAPSHOT = path.join(DIR, 'snapshot.json');
const LEVERAGE = path.join(DIR, 'leverage.json');
const BARS = 600;

const cfgFile = JSON.parse(fs.readFileSync(WATCHLIST, 'utf8'));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
state.marks ||= {};
state.log ||= [];
state.watches = cfgFile.watches || [];
const settings = cfgFile.settings || {};
const globalCfg = settings.cfg || {};

initPush();

// Published for the browser build: MEXC has no CORS headers, so the page can't
// fetch this itself.
await refreshLeverage().catch(() => {});

const fired = [];
const rows = [];

for (const w of state.watches) {
  if (w.enabled === false) continue;

  const marks = (state.marks[w.id] ||= {});
  const firstSight = !marks.seen;

  let a = null, error = null;
  try {
    const candles = await fetchCandles(w.market, w.symbol, w.interval, BARS);
    a = analyze(candles, { ...globalCfg, ...(w.cfg || {}) });
  } catch (e) {
    error = e.message;
    console.error(`[scan] ${w.id}: ${error}`);
  }

  if (a) {
    const lastTrade = a.trades[a.trades.length - 1];

    // The live feed only alerts when the signal lands on the newest closed bar,
    // because it never misses one. A scheduled run can wake up several bars
    // late, so identity is the entry/exit timestamp alone — late beats silent.
    if (a.position && marks.entryTime !== a.position.entryTime) {
      marks.entryTime = a.position.entryTime;
      marks.preAlertAt = 0;
      if (!firstSight) fired.push(['ENTRY', w, a]);
    }
    if (!a.position) marks.entryTime = null;

    if (a.position?.tp1Done && marks.tp1For !== a.position.entryTime) {
      marks.tp1For = a.position.entryTime;
      if (!firstSight) fired.push(['TP1', w, a]);
    }

    if (lastTrade && marks.exitTime !== lastTrade.exitTime) {
      marks.exitTime = lastTrade.exitTime;
      if (!firstSight) fired.push(['EXIT', w, { ...a, justClosed: lastTrade }]);
    }

    const f = a.forecast;
    if (f?.imminent && !a.position) {
      const stale = Date.now() - (marks.preAlertAt || 0) > 10 * 60 * 1000;
      if (!firstSight && (stale || marks.preAlertSide !== f.side)) {
        marks.preAlertAt = Date.now();
        marks.preAlertSide = f.side;
        fired.push(['PREALERT', w, a]);
      }
    }

    marks.seen = true;
  }

  rows.push({
    id: w.id, market: w.market, symbol: w.symbol, interval: w.interval, error,
    analysis: a && {
      price: a.price, rsi: a.rsi, atrPct: a.atrPct, volRatio: a.volRatio,
      macdHist: a.macdHist, position: a.position, forecast: a.forecast,
      profile: a.profile, regime: a.regime, stats: a.stats,
      recent: a.trades.slice(-10).reverse(), lastClosedTime: a.lastClosedTime
    }
  });
}

// Delivery honours the same switches as the live server, so muting in the app
// mutes the runner too once the watchlist is synced.
for (const [kind, w, a] of fired) {
  if (settings.muted) { console.log(`[${kind}] ${w.id} suppressed — muted`); continue; }
  if (kind === 'PREALERT' && settings.preAlerts === false) continue;
  if (kind === 'EXIT' && settings.exitAlerts === false) continue;

  const msg = buildMessage(kind, w, a);
  const entry = {
    kind, id: w.id, symbol: w.symbol, interval: w.interval, market: w.market,
    title: msg.title, body: msg.body, priority: msg.priority,
    side: a.position?.side || a.forecast?.side || a.justClosed?.side || null,
    detail: kind === 'ENTRY' ? a.position : kind === 'EXIT' ? a.justClosed : a.forecast,
    at: Date.now()
  };
  state.log.unshift(entry);
  const res = await dispatch(msg, [], () => {});
  console.log(`[${kind}] ${w.symbol} ${w.interval} →`, JSON.stringify(res));
}

if (state.log.length > 300) state.log.length = 300;
state.lastRun = Date.now();

// The watchlist is not written back — main owns it.
fs.writeFileSync(STATE, JSON.stringify(
  { marks: state.marks, log: state.log, lastRun: state.lastRun }, null, 2));
fs.writeFileSync(SNAPSHOT, JSON.stringify({
  at: state.lastRun,
  sources: feedSources(),
  alerts: state.log.slice(0, 40),
  watches: rows
}, null, 2));

const lev = leverageDump();
if (Object.keys(lev).length) fs.writeFileSync(LEVERAGE, JSON.stringify(lev));

console.log(`[scan] ${rows.length} watch(es), ${fired.length} alert(s), sources ${JSON.stringify(feedSources())}`);
