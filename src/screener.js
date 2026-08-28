// "Best suitable" — run the strategy over the most volatile coins on every
// scalping timeframe and rank what actually pays, rather than what merely moves.

import { fetchCandles, fetchCandlesDeep } from './providers.js';
import { analyze } from './strategy.js';
import { maxLev } from './leverage.js';
import { filterTrades, aggregate } from './history.js';

const TFS = ['1m', '3m', '5m'];
const BARS = 1000;
const TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000 };
// Indicators need bars before the window opens, or the first trades inside it
// get judged on half-warm averages.
const WARMUP = 300;
// Four pages of 1500 candles per series. Deeper than this and one scan turns
// into hundreds of API calls, so a long window on 1m reports how far it got
// instead of trying to fetch a month of minutes for 18 coins.
const MAX_BARS = 6000;
// A `to` with no `from` still needs a depth to fetch; give it a week of runway.
const OPEN_ENDED = 7 * 86400000;

function barsFor(tf, depthFrom) {
  if (!depthFrom) return BARS;
  const span = Date.now() - depthFrom;
  return Math.min(MAX_BARS, Math.max(BARS, Math.ceil(span / TF_MS[tf]) + WARMUP));
}

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

  async run({ market = 'futures', coins = 18, minTrades = 8, from = 0, to = 0, ttl = 300000 } = {}) {
    const key = `${market}:${coins}:${from}:${to}`;
    if (this.cache && Date.now() - this.cache.at < ttl && this.cache.key === key) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this._run(market, coins, minTrades, from, to, key).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _run(market, coins, minTrades, from, to, key) {
    const board = await this.vol.board(market, []);
    const universe = board.slice(0, coins);
    const cfg = this.getCfg();

    // A window narrows the sample, so demanding the full-scan trade count would
    // empty the list for short periods. Ask only that the coin traded in it.
    const windowed = !!(from || to);
    const need = windowed ? 2 : minTrades;
    const depthFrom = from || (to ? to - OPEN_ENDED : 0);

    const jobs = [];
    for (const c of universe) for (const tf of TFS) jobs.push({ c, tf });

    const results = await mapLimit(jobs, 10, async ({ c, tf }) => {
      const want = barsFor(tf, depthFrom);
      const candles = want > BARS
        ? await fetchCandlesDeep(market, c.symbol, tf, want)
        : await fetchCandles(market, c.symbol, tf, want);
      const first = candles[0]?.t ?? null;
      const a = analyze(candles, cfg);
      if (!a) return { first, row: null };
      // The backtest runs on everything fetched so the indicators are warm; the
      // window is applied to the trades it produced, by when they closed.
      const trades = windowed ? filterTrades(a.trades, { from, to }) : a.trades;
      if (trades.length < need) return { first, row: null };
      const s = windowed ? aggregate(trades) : a.stats;
      const lev = maxLev(market, c.symbol);
      // Cap the leverage figure at what this symbol's own stop can survive —
      // quoting a return at leverage that liquidates first is meaningless.
      // Recommended = the stop costs about 40% of margin, capped by what the
      // stop can survive at all, and never above the exchange maximum.
      const liq = a.calibration?.liqLev ?? null;
      const comfy = a.calibration?.safeLev ?? null;
      const usable = Math.max(1, Math.min(lev || 1, comfy ?? lev ?? 1, liq ?? lev ?? 1));
      return {
        first,
        row: {
          symbol: c.symbol, interval: tf, market,
          price: c.price, vol5m: c.vol5m, vol1h: c.vol1h, vol1d: c.vol1d, quoteVol: c.quoteVol,
          trades: s.trades, allTrades: a.stats.trades, winRate: s.winRate,
          totalR: s.totalR, totalPct: s.totalPct,
          avgWinPct: s.avgWinPct, avgLossPct: s.avgLossPct,
          adx: a.regime?.adx ?? null,
          stopPct: a.calibration?.stopPct ?? null,
          maxLev: lev, usableLev: usable,
          pctAtUsable: s.totalPct * (usable || 1),
          coversFrom: first,
          inPosition: !!a.position
        }
      };
    });

    const done = results.filter(Boolean);
    const rows = done.map(r => r.row).filter(Boolean)
      .filter(r => r.totalPct > 0)
      .sort((a, b) => b.totalPct - a.totalPct);

    // How far back the scan actually got. The shallowest series is the one that
    // limits the answer, so an unreachable window reads as depth, not absence.
    const firsts = done.map(r => r.first).filter(Boolean);
    const reach = firsts.length
      ? { deepest: Math.min(...firsts), shallowest: Math.max(...firsts) }
      : null;

    // Best timeframe per coin, so one strong coin doesn't fill the whole list
    const bestPerCoin = [];
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.symbol)) continue;
      seen.add(r.symbol);
      bestPerCoin.push(r);
    }

    this.cache = {
      at: Date.now(), key, coins, market, from, to, reach,
      scanned: jobs.length, qualified: done.filter(r => r.row).length,
      profitable: rows.length,
      rows, bestPerCoin
    };
    return this.cache;
  }
}
