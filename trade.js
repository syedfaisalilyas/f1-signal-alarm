#!/usr/bin/env node
// The F1 Big Winners bot.
//
//   node trade.js              a dry run — decides everything, places nothing
//   LIVE=1 node trade.js       actually trades
//
// Run it on a timer (cron every 5 minutes) somewhere outside the US. GitHub's
// runners are in US datacentres and Binance answers 451 to every one of them,
// so the scanner can live there but this cannot.
//
// What it does each pass, in order:
//   1. manage what is already open — raise trailing stops before anything else,
//      because protecting a running trade matters more than finding a new one
//   2. open fresh long ignitions that pass the strategy's filters
//
// Safety rails, all of them deliberate:
//   - dry run unless LIVE=1
//   - isolated margin, so one liquidation cannot reach the rest of the wallet
//   - the stop lives on the exchange as closePosition, so a crashed bot still
//     has a protected position
//   - a hard cap on open positions and on margin per trade
//   - one entry per symbol per ignition, remembered across restarts

import './src/env.js';
import fs from 'fs';
import path from 'path';
import { fetchCandles } from './src/providers.js';
import { scanUniverse, DEFAULTS } from './src/ignition.js';
import * as ex from './src/exchange/binance.js';

const LIVE = process.env.LIVE === '1';
// Paper mode needs no keys at all: real market data, real decisions, a
// pretend wallet. It is how you watch the thing work before trusting it.
const PAPER = process.env.PAPER === '1' || (!process.env.BINANCE_KEY && !LIVE);
const STATE = path.join(process.cwd(), 'cloud', 'trades.json');

const cfgFile = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'cloud', 'watchlist.json'), 'utf8')); }
  catch { return {}; }
})();
const ig = cfgFile.settings?.ignition || {};

const CFG = {
  interval: ig.interval || '1h',
  minQuoteVol: ig.minQuoteVol || 3e6,
  alertOn: ig.alertOn || 'longs',          // 'longs' | 'A' | 'all'
  fresh: ig.fresh ?? 2,                     // only a break this new is tradeable
  riskPct: +(process.env.MARGIN_PCT || ig.marginPct || 1),   // margin per trade, % of wallet
  maxOpen: +(process.env.MAX_OPEN || ig.maxOpen || 8),
  maxLev: +(process.env.MAX_LEV || ig.maxLev || 0),          // 0 = the symbol's exchange max
  trail: ig.trailGive ?? DEFAULTS.trailGive
};

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
state.open ||= {};      // symbol -> { entry, peak, qty, lev, stopPrice, stopOrderId, signalTime }
state.done ||= {};      // symbol:signalTime -> when we acted, so a signal fires once

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const save = () => {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const cut = Date.now() - 7 * 864e5;
  for (const [k, t] of Object.entries(state.done)) if (t < cut) delete state.done[k];
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
};

if (LIVE && !process.env.BINANCE_KEY) {
  console.error('LIVE=1 but BINANCE_KEY / BINANCE_SECRET are not set. Refusing to start.');
  process.exit(1);
}

await ex.syncTime();
const rules = await ex.rules();
const wallet = PAPER
  ? { total: +(process.env.PAPER_BALANCE || 50), available: +(process.env.PAPER_BALANCE || 50) }
  : await ex.balance().catch(e => {
      console.error(`could not read the account: ${e.message}`);
      process.exit(1);
    });
log(`wallet $${wallet.total.toFixed(2)} (available $${wallet.available.toFixed(2)})` +
  `  ·  ${LIVE ? 'LIVE — placing real orders' : PAPER ? 'PAPER (no keys, nothing placed)' : 'DRY RUN'}`);

// ─── 1. manage open positions ───
// Raise the trail on anything already running. This happens first and without
// depending on the scan, so a slow or failing sweep never delays a stop.
const live = PAPER ? [] : await ex.positions();
const mine = live.filter(p => state.open[p.symbol] && p.side === 'LONG');

for (const p of mine) {
  const s = state.open[p.symbol];
  s.peak = Math.max(s.peak || p.entry, p.mark);
  const r = rules.get(p.symbol);
  const want = ex.roundPrice(r, s.peak * (1 - CFG.trail));

  if (want > (s.stopPrice || 0) && want < p.mark) {
    if (LIVE) {
      try {
        if (s.stopOrderId) await ex.cancelOrder(p.symbol, s.stopOrderId).catch(() => {});
        const o = await ex.stopLong(p.symbol, want);
        s.stopOrderId = o.orderId;
      } catch (e) { log(`  ! ${p.symbol} stop update failed: ${e.message}`); continue; }
    }
    const up = ((p.mark - p.entry) / p.entry * 100);
    log(`  ↑ ${p.symbol} trail ${s.stopPrice ? s.stopPrice.toPrecision(6) : 'none'} → ${want.toPrecision(6)}` +
      `  (peak ${s.peak.toPrecision(6)}, position ${up >= 0 ? '+' : ''}${up.toFixed(1)}% = ${(up * p.lev).toFixed(0)}% on margin)`);
    s.stopPrice = want;
  }
}

// Positions that closed while we were away — the exchange stop did its job.
for (const sym of Object.keys(state.open)) {
  if (!live.some(p => p.symbol === sym)) {
    log(`  ✓ ${sym} closed (stop hit or manually closed)`);
    delete state.open[sym];
  }
}
log(`managing ${Object.keys(state.open).length} open position(s)`);

// ─── 2. look for something new ───
if (Object.keys(state.open).length >= CFG.maxOpen) {
  log(`at the ${CFG.maxOpen}-position cap — not opening more`);
} else {
  const sweep = await scanUniverse({
    market: 'futures', interval: CFG.interval, minQuoteVol: CFG.minQuoteVol,
    cfg: ig.cfg || {}, fetchCandles
  });
  log(`swept ${sweep.scanned} symbols on ${CFG.interval} · ${sweep.igniting.length} igniting`);

  for (const r of sweep.igniting) {
    if (Object.keys(state.open).length >= CFG.maxOpen) break;
    const f = r.fired;
    const key = `${r.symbol}:${f.barTime}`;

    if (f.barsAgo > CFG.fresh) continue;
    if (CFG.alertOn === 'longs' && f.side !== 'LONG') continue;
    if (CFG.alertOn === 'A' && f.grade !== 'A') continue;
    if (f.side !== 'LONG') continue;                    // the bot is long-only, always
    if (state.done[key] || state.open[r.symbol]) continue;

    const rule = rules.get(r.symbol);
    if (!rule) { log(`  – ${r.symbol} not on Binance futures`); continue; }

    const cap = PAPER ? (rules.get(r.symbol) ? 75 : 20) : await ex.maxLeverage(r.symbol).catch(() => 20);
    const lev = Math.max(1, CFG.maxLev > 0 ? Math.min(CFG.maxLev, cap) : cap);
    const margin = wallet.total * CFG.riskPct / 100;
    const notional = margin * lev;
    const qty = ex.roundQty(rule, notional / f.entry);

    // A wallet this small cannot always meet the exchange's floor. Say which
    // floor and by how much, rather than letting the order fail cryptically.
    if (qty < rule.minQty || qty * f.entry < rule.minNotional) {
      log(`  – ${r.symbol} too small: $${(qty * f.entry).toFixed(2)} notional, needs $${rule.minNotional} (min qty ${rule.minQty})`);
      continue;
    }
    if (margin > wallet.available) { log(`  – ${r.symbol} not enough free margin`); continue; }

    const stop = ex.roundPrice(rule, f.stop);
    log(`  ${LIVE ? '→ BUY' : '→ would buy'} ${r.symbol} ${qty} @ ~${f.entry.toPrecision(6)} · ${lev}x · ` +
      `margin $${margin.toFixed(2)} · stop ${stop.toPrecision(6)} (${f.riskPct.toFixed(2)}%) · grade ${f.grade}`);

    if (!LIVE) { state.done[key] = Date.now(); continue; }
    try {
      await ex.setIsolated(r.symbol);
      await ex.setLeverage(r.symbol, lev);
      const fill = await ex.marketBuy(r.symbol, qty);
      const o = await ex.stopLong(r.symbol, stop);
      state.open[r.symbol] = {
        entry: f.entry, peak: f.entry, qty, lev, stopPrice: stop,
        stopOrderId: o.orderId, signalTime: f.barTime, at: Date.now()
      };
      state.done[key] = Date.now();
      log(`    filled, order ${fill.orderId}, stop ${o.orderId}`);
    } catch (e) {
      log(`    ! ${r.symbol} failed: ${e.message}`);
      state.done[key] = Date.now();          // don't hammer a symbol that rejects
    }
  }
}

save();
log('done');
