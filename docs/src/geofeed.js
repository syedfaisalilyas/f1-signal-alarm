// Fallbacks for when Binance answers HTTP 451.
//
// Binance blocks its own hosts from restricted regions — every US datacentre
// included, which is where GitHub's runners live. Two sources survive that:
// data-api.binance.vision mirrors the spot REST API, and MEXC carries the
// perps. Same candles, different plumbing, so the strategy never sees it.

export const SPOT_MIRROR = 'https://data-api.binance.vision/api/v3';
const MEXC = 'https://contract.mexc.com/api/v1/contract';

export const isGeoBlocked = (err) => /\b451\b/.test(String(err?.message));

// MEXC perps are BASE_QUOTE where Binance is BASEQUOTE.
export function mexcSymbol(symbol) {
  const m = symbol.toUpperCase().match(/^(.*?)(USDT|USDC|USD)$/);
  return m ? `${m[1]}_${m[2]}` : symbol.toUpperCase();
}

// MEXC has no 3m contract candle, so it gets built from three 1m bars.
const IV = {
  '1m': { unit: 'Min1', factor: 1, min: 1 },
  '3m': { unit: 'Min1', factor: 3, min: 1 },
  '5m': { unit: 'Min5', factor: 1, min: 5 },
  '15m': { unit: 'Min15', factor: 1, min: 15 },
  '30m': { unit: 'Min30', factor: 1, min: 30 },
  '1h': { unit: 'Min60', factor: 1, min: 60 },
  '4h': { unit: 'Hour4', factor: 1, min: 240 },
  '1d': { unit: 'Day1', factor: 1, min: 1440 }
};

// 3m is the one interval MEXC can't serve natively; the caller rolls it up.
export const mexcFactor = (interval) => IV[interval]?.factor || 1;

async function jget(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'f1-alarm/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url.split('?')[0]}`);
  const d = await res.json();
  if (d && d.success === false) throw new Error(`mexc: ${d.message || d.code}`);
  return d;
}

// Columnar response — keys are named, and the order is time/open/close/high/low,
// so anything positional would quietly swap close and high.
export async function mexcCandles(symbol, interval, limit = 500) {
  const iv = IV[interval];
  if (!iv) throw new Error(`no MEXC contract candle for ${interval}`);
  const barMs = iv.min * 60000;
  const span = Math.ceil(limit * iv.factor) * iv.min * 60;
  const start = Math.floor(Date.now() / 1000) - span;
  const d = (await jget(`${MEXC}/kline/${mexcSymbol(symbol)}?interval=${iv.unit}&start=${start}`)).data;
  if (!d?.time?.length) return [];
  const bars = d.time.map((t, i) => ({
    t: t * 1000,
    o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +d.vol[i],
    closeTime: t * 1000 + barMs - 1
  }));
  bars.forEach(b => { b.closed = b.closeTime < Date.now(); });
  return bars;
}

export async function mexcTicker(symbol) {
  const d = (await jget(`${MEXC}/ticker?symbol=${mexcSymbol(symbol)}`)).data;
  return { price: +d.lastPrice, changePct: +d.riseFallRate * 100, volume: +d.amount24 };
}

// The whole perp board in one call — what fapi's bulk ticker gives, for the
// regions where fapi answers 451.
export async function mexcAllTickers() {
  const d = (await jget(`${MEXC}/ticker`)).data || [];
  return d.map(t => {
    const [base, quote] = t.symbol.split('_');
    return {
      symbol: `${base}${quote}`,
      price: +t.lastPrice,
      changePct: +t.riseFallRate * 100,
      quoteVol: +t.amount24            // amount24 is quote volume, volume24 is contracts
    };
  }).filter(r => r.symbol && isFinite(r.quoteVol));
}

export async function mexcPerps() {
  const d = (await jget(`${MEXC}/detail`)).data || [];
  return d
    .filter(c => c.state === 0)                       // 0 = enabled for trading
    .map(c => {
      const [base, quote] = c.symbol.split('_');
      return {
        market: 'futures', symbol: `${base}${quote}`, base, quote,
        label: `${base}/${quote}`, tick: +c.priceUnit || 0
      };
    });
}
