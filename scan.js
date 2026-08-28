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
import { scanUniverse } from './src/ignition.js';
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

// ─── market-wide coil watch ───
// The loop above tells you what your setups are doing on the four coins you
// chose. This asks the other question: out of every liquid perp on the
// exchange, which one just left a dead range? Same dedupe plumbing — one alert
// per symbol per candle, remembered in the same state file.
const ig = settings.ignition || {};
const igniteFirstRun = !state.ignited;      // seed silently, don't blast the board
state.ignited ||= {};

if (ig.enabled !== false && !settings.muted) {
  try {
    const sweep = await scanUniverse({
      market: ig.market || 'futures',
      interval: ig.interval || '5m',
      minQuoteVol: ig.minQuoteVol || 3e6,
      cfg: ig.cfg || {},
      fetchCandles
    });
    // Only a break that is still fresh. A coin that left its base twenty
    // candles ago is not "from the start" any more, and chasing it is how you
    // buy the top.
    const freshMax = ig.fresh ?? 2;
    let sent = 0;
    // Grade A is the setup that survived a time-split test: a quiet coin below
    // its 30-day high, flat or down on the week, low volatility, while BTC is
    // rising. On held-out data it won 50% against the unfiltered 24%. It is
    // also rare — expect a couple a week, not a couple a day. Everything else
    // still shows on the board; this only decides what is worth waking up for.
    const gradeOnly = ig.longsOnly !== false;
    for (const r of sweep.igniting) {
      if (r.fired.barsAgo > freshMax) continue;
      if (gradeOnly && r.fired.grade !== 'A') continue;
      const key = `${r.symbol}:${sweep.interval}`;
      if (state.ignited[key] === r.fired.barTime) continue;
      state.ignited[key] = r.fired.barTime;
      if (igniteFirstRun) continue;

      const f = r.fired;
      const n = v => Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(6);
      const title = `${f.side === 'LONG' ? '🚀' : '🔻'} IGNITION ${f.side} ${r.symbol} ${sweep.interval}`;
      const body =
        `Broke a ${f.boxWidthPct.toFixed(1)}% coil (${f.coilBars} bars) at ${n(f.side === 'LONG' ? f.boxHi : f.boxLo)}\n` +
        `Range ${f.rangeX.toFixed(1)}× ATR · volume ${f.volX.toFixed(1)}× · body ${(f.bodyRatio * 100).toFixed(0)}%\n` +
        `Entry ${n(f.entry)}\n` +
        `Stop  ${n(f.stop)}   (${f.riskPct.toFixed(2)}%)\n` +
        `Then trail ${((f.trailGive ?? 0.25) * 100).toFixed(0)}% below the high — do not sell at a fixed target.\n` +
        `Size at ${f.useLev || f.maxLev || '?'}x — keep the margin to about 1% of the wallet.\n` +
        `Setup: ${f.gradeWhy || 'grade ' + (f.grade || '?')}\n` +
        `(ref TP1 ${n(f.tp1)} · TP2 ${n(f.tp2)} · ${f.rr1.toFixed(1)}R)\n` +
        `24h volume $${(r.quoteVol / 1e6).toFixed(1)}M · ${r.changePct.toFixed(1)}% today`;

      state.log.unshift({
        kind: 'IGNITION', id: `${r.market}:${r.symbol}:${sweep.interval}`,
        symbol: r.symbol, interval: sweep.interval, market: r.market,
        title, body, priority: 5, side: f.side, detail: f, at: Date.now()
      });
      const res = await dispatch({
        title, body, priority: 5, tags: ['rocket'],
        telegram: `<b>${title}</b>\n<pre>${body}</pre>`
      }, [], () => {});
      sent++;
      console.log(`[IGNITION] ${r.symbol} ${sweep.interval} →`, JSON.stringify(res));
    }
    console.log(`[ignite] ${sweep.scanned} symbols on ${sweep.interval}, ` +
      `${sweep.igniting.length} igniting, ${sweep.coiling.length} coiled, ${sent} alert(s)` +
      (igniteFirstRun ? ' — first run, seeded silently' : ''));
  } catch (e) {
    console.error('[ignite] sweep failed:', e.message);
  }
}

// Keep the dedupe map from growing forever.
const igCutoff = Date.now() - 24 * 60 * 60 * 1000;
for (const [k, t] of Object.entries(state.ignited)) if (t < igCutoff) delete state.ignited[k];

if (state.log.length > 300) state.log.length = 300;
state.lastRun = Date.now();

// The watchlist is not written back — main owns it.
fs.writeFileSync(STATE, JSON.stringify(
  { marks: state.marks, ignited: state.ignited, log: state.log, lastRun: state.lastRun }, null, 2));
fs.writeFileSync(SNAPSHOT, JSON.stringify({
  at: state.lastRun,
  sources: feedSources(),
  alerts: state.log.slice(0, 40),
  watches: rows
}, null, 2));

const lev = leverageDump();
if (Object.keys(lev).length) fs.writeFileSync(LEVERAGE, JSON.stringify(lev));

console.log(`[scan] ${rows.length} watch(es), ${fired.length} alert(s), sources ${JSON.stringify(feedSources())}`);
