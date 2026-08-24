#!/usr/bin/env node
// Backtest the strategy against live Binance data and report the result in
// dollars, not in leveraged percentages.
//
//   npm run backtest -- --tf 30m --days 60
//   npm run backtest -- --symbol TUTUSDT --tf 3m --days 14 --notional 100
//   npm run backtest -- --tf 5m --coins 10 --cfg '{"minEmaSep":0,"runner":true}'
//
// Every run splits its window in half and scores each half separately. A
// strategy that only works in one half is fitted to that half, not real — the
// split is the whole point of the tool, so it is not optional.

import '../src/env.js';
import { VolatilityScanner } from '../src/volatility.js';
import { analyze } from '../src/strategy.js';
import { fetchCandles } from '../src/providers.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const TF = arg('tf', '30m');
const DAYS = Number(arg('days', 60));
const NOTIONAL = Number(arg('notional', 100));      // $ per trade
const COINS = Number(arg('coins', 20));
const SYMBOL = arg('symbol', null);
const FEE_PCT = Number(arg('fee', 0.14));           // % round trip incl. slippage
const cfg = JSON.parse(arg('cfg', '{}'));

const MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3 };
const FUT = 'https://fapi.binance.com/fapi/v1';

// Binance caps a request at 1500 candles, so page back until the window is covered.
async function history(symbol, tf, days) {
  const need = Math.ceil((days * 86400e3) / MS[tf]);
  const out = [];
  let endTime = Date.now();
  for (let page = 0; page < 20 && out.length < need; page++) {
    const res = await fetch(`${FUT}/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${endTime}`);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const raw = await res.json();
    if (!raw.length) break;
    out.unshift(...raw.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeTime: k[6], closed: true
    })));
    if (raw.length < 1500) break;
    endTime = out[0].t - 1;
    await new Promise(r => setTimeout(r, 100));
  }
  const seen = new Set();
  return out.filter(b => (seen.has(b.t) ? false : seen.add(b.t))).sort((a, b) => a.t - b.t);
}

const symbols = SYMBOL ? [SYMBOL]
  : (await new VolatilityScanner().board('futures', [])).slice(0, COINS).map(r => r.symbol);

console.log(`\n${TF} · ${DAYS} days · ${symbols.length} symbol(s) · $${NOTIONAL} per trade · ${FEE_PCT}% round trip`);
if (Object.keys(cfg).length) console.log(`config overrides: ${JSON.stringify(cfg)}`);

const trades = [];
for (const sym of symbols) {
  try {
    const a = analyze(await history(sym, TF, DAYS), cfg);
    if (a) for (const t of a.trades) trades.push({ ...t, sym });
  } catch (e) {
    console.log(`  skipped ${sym}: ${e.message}`);
  }
}

if (!trades.length) {
  console.log('\nno trades in that window');
  process.exit(0);
}

trades.sort((a, b) => a.exitTime - b.exitTime);
const feeUsd = NOTIONAL * FEE_PCT / 100;

function report(label, rows) {
  if (rows.length < 5) return console.log(`\n${label}: only ${rows.length} trades — too few to judge`);
  const wins = rows.filter(t => t.pnlPct > 0);
  const losses = rows.filter(t => t.pnlPct <= 0);
  const gross = rows.reduce((s, t) => s + NOTIONAL * t.pnlPct / 100, 0);
  const fees = feeUsd * rows.length;
  const rs = rows.map(t => t.r - FEE_PCT / t.riskPct);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rs.length - 1));
  const days = (rows.at(-1).exitTime - rows[0].exitTime) / 86400e3;

  console.log(`\n${label}`);
  console.log(`  trades          ${rows.length}  (${(rows.length / days).toFixed(1)}/day over ${days.toFixed(0)} days)`);
  console.log(`  win rate        ${(wins.length / rows.length * 100).toFixed(0)}%`);
  console.log(`  avg win         ${wins.length ? '+' + (wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2) : '—'}%`);
  console.log(`  avg loss        ${losses.length ? (losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2) : '—'}%`);
  console.log(`  gross           ${gross >= 0 ? '+' : '-'}$${Math.abs(gross).toFixed(2)}`);
  console.log(`  fees            -$${fees.toFixed(2)}`);
  console.log(`  NET             ${gross - fees >= 0 ? '+' : '-'}$${Math.abs(gross - fees).toFixed(2)}   ($${((gross - fees) / days).toFixed(2)}/day)`);
  console.log(`  per trade       ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}R   t-stat ${(mean / (sd / Math.sqrt(rs.length))).toFixed(2)}`);

  // Drawdown is what actually decides whether a strategy is survivable: the
  // average can be positive while the path to it empties the account.
  let wallet = 100, peak = 100, maxDD = 0, worst = 0, streak = 0, worstStreak = 0, ruin = false;
  for (const t of rows) {
    const pnl = NOTIONAL * t.pnlPct / 100 - feeUsd;
    worst = Math.min(worst, pnl);
    wallet += pnl;
    if (wallet <= 0) { ruin = true; break; }
    peak = Math.max(peak, wallet);
    maxDD = Math.max(maxDD, (peak - wallet) / peak * 100);
    if (pnl < 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
  }
  console.log(`  worst trade     -$${Math.abs(worst).toFixed(2)}   worst losing streak ${worstStreak}`);
  console.log(`  max drawdown    ${ruin ? 'ACCOUNT WIPED OUT' : maxDD.toFixed(1) + '%'}   (wallet $100 -> $${Math.max(0, wallet).toFixed(2)})`);
}

const mid = trades[Math.floor(trades.length / 2)].exitTime;
report('FIRST HALF  (find rules here)', trades.filter(t => t.exitTime < mid));
report('SECOND HALF (prove them here)', trades.filter(t => t.exitTime >= mid));
report('WHOLE WINDOW', trades);

console.log(`
Reading this: the t-stat is how many standard errors the average trade sits
above zero. Below ~2 the result is indistinguishable from luck, however good
the dollar figure looks. Both halves must be positive, or the rule is fitted
to the half that produced it.
`);
