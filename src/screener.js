// "Best suitable" — run the strategy over the most volatile coins on every
// scalping timeframe and rank what actually pays, rather than what merely moves.

import { fetchCandles } from './providers.js';
import { analyze } from './strategy.js';
import { maxLev } from './leverage.js';

const TFS = ['1m', '3m', '5m'];
const BARS = 1000;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  }));
  return out;
}

export class Screener {
  constructor(vol, getCfg = () => ({})) {
    this.vol = vol;
    this.getCfg = getCfg;
    this.cache = null;
    this.inflight = null;
  }

  async run({ market = 'futures', coins = 18, minTrades = 8, ttl = 300000 } = {}) {
    if (this.cache && Date.now() - this.cache.at < ttl && this.cache.coins === coins) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this._run(market, coins, minTrades).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _run(market, coins, minTrades) {
    const board = await this.vol.board(market, []);
    const universe = board.slice(0, coins);
    const cfg = this.getCfg();

    const jobs = [];
    for (const c of universe) for (const tf of TFS) jobs.push({ c, tf });

    const results = await mapLimit(jobs, 10, async ({ c, tf }) => {
      const candles = await fetchCandles(market, c.symbol, tf, BARS);
      const a = analyze(candles, cfg);
      if (!a || a.stats.trades < minTrades) return null;
      const s = a.stats;
      const lev = maxLev(market, c.symbol);
      // Cap the leverage figure at what this symbol's own stop can survive —
      // quoting a return at leverage that liquidates first is meaningless.
      // Recommended = the stop costs about 40% of margin, capped by what the
      // stop can survive at all, and never above the exchange maximum.
      const liq = a.calibration?.liqLev ?? null;
      const comfy = a.calibration?.safeLev ?? null;
      const usable = Math.max(1, Math.min(lev || 1, comfy ?? lev ?? 1, liq ?? lev ?? 1));
      return {
        symbol: c.symbol, interval: tf, market,
        price: c.price, vol5m: c.vol5m, vol1h: c.vol1h, vol1d: c.vol1d, quoteVol: c.quoteVol,
        trades: s.trades, winRate: s.winRate, totalR: s.totalR, totalPct: s.totalPct,
        avgWinPct: s.avgWinPct, avgLossPct: s.avgLossPct,
        adx: a.regime?.adx ?? null,
        stopPct: a.calibration?.stopPct ?? null,
        maxLev: lev, usableLev: usable,
        pctAtUsable: s.totalPct * (usable || 1),
        inPosition: !!a.position
      };
    });

    const rows = results.filter(Boolean)
      .filter(r => r.totalPct > 0)
      .sort((a, b) => b.totalPct - a.totalPct);

    // Best timeframe per coin, so one strong coin doesn't fill the whole list
    const bestPerCoin = [];
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.symbol)) continue;
      seen.add(r.symbol);
      bestPerCoin.push(r);
    }

    this.cache = {
      at: Date.now(), coins, market,
      scanned: jobs.length, qualified: results.filter(Boolean).length,
      profitable: rows.length,
      rows, bestPerCoin
    };
    return this.cache;
  }
}
