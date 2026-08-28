#!/usr/bin/env node
// What the coil→ignition setup actually did, rather than what it looks like it
// should do.
//
//   node tools/ignition-backtest.js --interval 15m --days 30 --coins 120
//   node tools/ignition-backtest.js --compare          # 5m vs 15m vs 1h
//
// Rules of the measurement, all chosen to be pessimistic rather than flattering:
//   - Entry is the NEXT candle's open, not the ignition candle's close. The
//     alert cannot exist until the candle closes, so its close is not a price
//     you could have had.
//   - When one candle's range contains both the stop and the target, the stop
//     is assumed to have hit first.
//   - MAE (how far it went against you before it worked) is tracked from the
//     entry, because that number — not the size of the eventual move — is what
//     decides the leverage you can survive.

import '../src/env.js';
import { fetchCandlesDeep } from '../src/providers.js';
import { ignitionEvents, universe, DEFAULTS } from '../src/ignition.js';

const args = process.argv.slice(2);
const has = n => args.includes(`--${n}`);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const TF_MIN = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
const days = +flag('days', 30);
const coins = +flag('coins', 120);
const minVol = +flag('min-vol', 5e6);
const horizonH = +flag('horizon', 24);           // hours to give a trade to work

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;

// A deep sweep is thousands of requests and Binance starts answering 429. The
// first version swallowed those, so a rate-limited pass reported "no ignitions
// found" — an empty result that looked like a finding. Retry, then count what
// still failed and say so.
async function withRetry(fn, tries = 4) {
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      if (a >= tries - 1) { failures++; throw e; }
      await sleep(/\b(429|418)\b/.test(String(e.message)) ? 4000 * (a + 1) : 800);
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

// One trade's life, bar by bar.
function outcome(bars, ev, horizon) {
  const i = ev.bar;
  const fill = bars[i + 1]?.o;
  if (!fill) return null;
  const long = ev.side === 'LONG';
  // The plan is anchored on the signal candle's close; re-anchor the risk on
  // the price actually paid so the R and the leverage math stay honest.
  const risk = Math.abs(fill - ev.stop);
  if (!(risk > 0)) return null;

  let mfe = 0, mae = 0, exit = null, exitBar = null, tp1 = false, tp2 = false;
  for (let k = i + 1; k <= Math.min(bars.length - 1, i + horizon); k++) {
    const b = bars[k];
    const up = long ? (b.h - fill) / fill * 100 : (fill - b.l) / fill * 100;
    const dn = long ? (fill - b.l) / fill * 100 : (b.h - fill) / fill * 100;
    if (up > mfe) mfe = up;
    if (exit === null && dn > mae) mae = dn;

    if (exit === null) {
      const stopHit = long ? b.l <= ev.stop : b.h >= ev.stop;
      const tp1Hit = long ? b.h >= ev.tp1 : b.l <= ev.tp1;
      const tp2Hit = long ? b.h >= ev.tp2 : b.l <= ev.tp2;
      if (tp1Hit) tp1 = true;
      if (tp2Hit) tp2 = true;
      if (stopHit) { exit = ev.stop; exitBar = k; }        // pessimistic: stop wins ties
      else if (tp2Hit) { exit = ev.tp2; exitBar = k; }
    }
  }
  if (exit === null) { exit = bars[Math.min(bars.length - 1, i + horizon)].c; exitBar = Math.min(bars.length - 1, i + horizon); }
  const pnlPct = (long ? exit - fill : fill - exit) / fill * 100;
  return {
    time: ev.barTime, side: ev.side, fill, mfe, mae, pnlPct, tp1, tp2,
    riskPct: risk / fill * 100,
    r: (long ? exit - fill : fill - exit) / risk,
    barsHeld: exitBar - i, volX: ev.volX, rangeX: ev.rangeX, coilPct: ev.boxWidthPct
  };
}

// One ticker call for the whole comparison — asking per timeframe just earns
// a 429 and kills the run.
let UNIVERSE = null;
async function board() {
  if (!UNIVERSE) UNIVERSE = (await universe('futures', minVol)).sort((a, b) => b.quoteVol - a.quoteVol).slice(0, coins);
  return UNIVERSE;
}

async function run(interval) {
  const bars = Math.min(9000, Math.ceil(days * 1440 / TF_MIN[interval]) + 400);
  const horizon = Math.ceil(horizonH * 60 / TF_MIN[interval]);
  const list = await board();
  process.stderr.write(`[${interval}] ${list.length} coins × ${bars} bars…\n`);

  const per = await mapLimit(list, 4, async (row) => {
    const candles = await withRetry(() => fetchCandlesDeep('futures', row.symbol, interval, bars));
    if (candles.length < 400) return null;
    const evs = ignitionEvents(candles);
    const trades = evs.map(e => outcome(candles, e, horizon)).filter(Boolean)
      .map(t => ({ ...t, symbol: row.symbol }));
    return { symbol: row.symbol, covered: candles.length, trades };
  });

  const ok = per.filter(Boolean);
  const trades = ok.flatMap(r => r.trades);
  return { interval, coins: ok.length, asked: list.length, bars, trades };
}

const pctl = (arr, q) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

function report(res) {
  const t = res.trades;
  if (!t.length) {
    console.log(`\n${res.interval}: NO DATA — ${res.coins}/${res.asked} coins returned candles ` +
      `(${failures} fetch failures). This is a failed run, not a result.`);
    return;
  }
  const wins = t.filter(x => x.pnlPct > 0);
  const totalR = t.reduce((s, x) => s + x.r, 0);
  // The leverage that survives this trade's own worst dip, before fees. Above
  // it, the position is liquidated before the move it predicted arrives.
  const survive = t.map(x => (x.mae > 0.05 ? 100 / x.mae : 200));
  console.log(`\n══ ${res.interval} · ${res.coins}/${res.asked} coins · ${days}d · ${t.length} ignitions ══`);
  console.log(`  win rate        ${(wins.length / t.length * 100).toFixed(0)}%   (TP1 touched ${(t.filter(x=>x.tp1).length / t.length * 100).toFixed(0)}%)`);
  console.log(`  avg result      ${mean(t.map(x => x.pnlPct)).toFixed(2)}%  ·  total ${totalR.toFixed(0)}R over ${t.length} trades`);
  console.log(`  avg best run    ${mean(t.map(x => x.mfe)).toFixed(2)}%   median ${pctl(t.map(x=>x.mfe),.5).toFixed(2)}%   top 10% ≥ ${pctl(t.map(x=>x.mfe),.9).toFixed(1)}%`);
  console.log(`  drawdown first  median ${pctl(t.map(x=>x.mae),.5).toFixed(2)}%   90th pct ${pctl(t.map(x=>x.mae),.9).toFixed(1)}%`);
  console.log(`  max leverage that survives the dip: median ${pctl(survive,.5).toFixed(0)}x · but 25% of trades cap at ${pctl(survive,.25).toFixed(0)}x or less`);
  const liq100 = t.filter(x => x.mae >= 1).length;
  console.log(`  at 100x, ${(liq100 / t.length * 100).toFixed(0)}% of these are liquidated before the move happens`);
  return t;
}

const intervals = has('compare') ? ['5m', '15m', '1h'] : [flag('interval', '15m')];
const all = [];
for (const iv of intervals) { all.push(await run(iv)); await sleep(20000); }
const flat = [];
for (const r of all) { const t = report(r); if (t) flat.push([r.interval, t]); }

// The headline the setup is actually sold on: the ones that ran.
for (const [iv, t] of flat) {
  const best = [...t].sort((a, b) => b.mfe - a.mfe).slice(0, 10);
  console.log(`\n  ${iv} — the ten biggest runs:`);
  console.log(`  ${'coin'.padEnd(15)}${'when'.padEnd(13)}${'side'.padEnd(7)}${'ran'.padStart(8)}${'dip 1st'.padStart(9)}${'safe lev'.padStart(10)}${'at that lev'.padStart(13)}`);
  for (const x of best) {
    const lev = Math.max(1, Math.min(125, Math.floor(x.mae > 0.05 ? 40 / x.mae : 125)));
    console.log(`  ${x.symbol.padEnd(15)}${new Date(x.time).toISOString().slice(5, 16).replace('T', ' ').padEnd(13)}` +
      `${x.side.padEnd(7)}${(x.mfe.toFixed(1) + '%').padStart(8)}${(x.mae.toFixed(2) + '%').padStart(9)}` +
      `${(lev + 'x').padStart(10)}${((x.mfe * lev).toFixed(0) + '%').padStart(13)}`);
  }
}
