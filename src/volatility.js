// Volatility scanner — ranks the market the way Binance's own board does:
// range as a percentage of the low, over 5m / 1h / 24h.
//
// 1D comes free for every symbol from one bulk ticker call. 5M and 1H both come
// from a single 5m-klines request per symbol (13 candles = one hour), so the
// board costs 1 + N requests rather than 1 + 2N.

const BASE = { spot: 'https://api.binance.com/api/v3', futures: 'https://fapi.binance.com/fapi/v1' };
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

async function jget(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`);
  return res.json();
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

const range = (hi, lo) => (lo > 0 && hi >= lo) ? (hi - lo) / lo * 100 : null;

// 5M = last closed 5m candle's range. 1H = range across the last 12.
// avg5m smooths the single-candle noise — a better read on "is this worth scalping".
async function intraday(market, symbol) {
  const k = await jget(`${BASE[market]}/klines?symbol=${symbol}&interval=5m&limit=13`);
  const closed = k.filter(x => x[6] < Date.now());
  if (!closed.length) return { vol5m: null, vol1h: null, avg5m: null };
  const last = closed.at(-1);
  const win = closed.slice(-12);
  const hi = Math.max(...win.map(x => +x[2]));
  const lo = Math.min(...win.map(x => +x[3]));
  const ranges = win.map(x => range(+x[2], +x[3])).filter(v => v !== null);
  return {
    vol5m: range(+last[2], +last[3]),
    vol1h: range(hi, lo),
    avg5m: ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null
  };
}

export class VolatilityScanner {
  constructor({ minQuoteVol = 1e6, depth = 45, ttl = 60000 } = {}) {
    this.minQuoteVol = minQuoteVol;   // ignore illiquid listings
    this.depth = depth;               // how many top-1D names get intraday detail
    this.ttl = ttl;
    this.cache = {};                  // market -> { rows, at }
    this.inflight = {};
  }

  async board(market = 'futures', pinned = []) {
    const c = this.cache[market];
    if (c && Date.now() - c.at < this.ttl && pinned.every(s => c.rows.some(r => r.symbol === s))) return c.rows;
    if (this.inflight[market]) return this.inflight[market];
    this.inflight[market] = this._scan(market, pinned).finally(() => { this.inflight[market] = null; });
    return this.inflight[market];
  }

  async _scan(market, pinned = []) {
    const tickers = await jget(`${BASE[market]}/ticker/24hr`);
    const base = tickers
      .filter(t => t.symbol.endsWith('USDT') && !LEVERAGED.test(t.symbol))
      .map(t => ({
        market, symbol: t.symbol,
        price: +t.lastPrice,
        changePct: +t.priceChangePercent,
        quoteVol: +t.quoteVolume,
        vol1d: range(+t.highPrice, +t.lowPrice)
      }))
      .filter(r => r.vol1d !== null && isFinite(r.vol1d));

    const liquid = base.filter(r => r.quoteVol >= this.minQuoteVol);
    liquid.sort((a, b) => b.vol1d - a.vol1d);

    // detail the leaders, plus anything the user is actually watching
    const want = new Set(liquid.slice(0, this.depth).map(r => r.symbol));
    for (const s of pinned) if (base.some(r => r.symbol === s)) want.add(s);

    const list = [...want];
    const detail = await mapLimit(list, 8, s => intraday(market, s));
    const byS = new Map(list.map((s, i) => [s, detail[i]]));

    const rows = base
      .filter(r => want.has(r.symbol))
      .map(r => ({ ...r, ...(byS.get(r.symbol) || { vol5m: null, vol1h: null, avg5m: null }), pinned: pinned.includes(r.symbol) }))
      .sort((a, b) => b.vol1d - a.vol1d);

    this.cache[market] = { rows, at: Date.now() };
    return rows;
  }

  // Single symbol, always fresh — used by the lookup box.
  async lookup(market, symbol) {
    const sym = symbol.toUpperCase();
    const [t, intra] = await Promise.all([
      jget(`${BASE[market]}/ticker/24hr?symbol=${sym}`),
      intraday(market, sym)
    ]);
    return {
      market, symbol: sym,
      price: +t.lastPrice,
      changePct: +t.priceChangePercent,
      quoteVol: +t.quoteVolume,
      vol1d: range(+t.highPrice, +t.lowPrice),
      ...intra
    };
  }
}
