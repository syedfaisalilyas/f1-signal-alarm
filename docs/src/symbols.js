// Names people actually type, mapped to something the feeds can answer.
//
// "gold" is not a Binance symbol and XAU/USD is not in Twelve Data's
// forex_pairs list, so both search boxes used to return nothing for it. Two
// routes exist and they are not equivalent:
//
//   PAXGUSDT   a token redeemable for one troy ounce, on Binance spot AND
//              futures. Priced 4431.28 against TradingView's 4433.89 spot gold
//              while this was written — 0.06%. It trades 24/7 and carries
//              volume, funding, open interest and the long/short book, so the
//              coin report works on it exactly as it does on any perp.
//   XAU/USD    the real thing, via Twelve Data, but only with a key, and it
//              arrives without volume or order flow — half the report goes
//              blank.
//
// So the proxy is the default and the real quote is used for price when a key
// exists. Anything the proxy cannot stand in for (silver, oil, FX crosses)
// needs the key and says so rather than silently resolving to nothing.

const hasForexKey = () => !!process.env.TWELVEDATA_KEY;

// One entry per tradeable idea, not per spelling. `aliases` is what gets typed.
export const INSTRUMENTS = [
  {
    id: 'gold',
    name: 'Gold',
    aliases: ['gold', 'xau', 'xauusd', 'xau/usd', 'xauusdt', 'goldusd', 'paxg', 'paxgusdt', 'gc', 'gc=f'],
    proxy: { market: 'futures', symbol: 'PAXGUSDT', note: 'PAXG — 1 token = 1 troy oz, tracks spot gold within ~0.1%' },
    forex: { market: 'forex', symbol: 'XAU/USD' },
    unit: 'oz'
  },
  {
    id: 'silver',
    name: 'Silver',
    aliases: ['silver', 'xag', 'xagusd', 'xag/usd', 'si'],
    forex: { market: 'forex', symbol: 'XAG/USD' },
    unit: 'oz'
  },
  {
    id: 'oil',
    name: 'Crude Oil (WTI)',
    aliases: ['oil', 'wti', 'crude', 'usoil', 'wtiusd', 'wti/usd', 'cl'],
    forex: { market: 'forex', symbol: 'WTI/USD' },
    unit: 'bbl'
  },
  { id: 'eurusd', name: 'EUR/USD', aliases: ['eurusd', 'eur/usd', 'euro'], forex: { market: 'forex', symbol: 'EUR/USD' } },
  { id: 'gbpusd', name: 'GBP/USD', aliases: ['gbpusd', 'gbp/usd', 'cable', 'pound'], forex: { market: 'forex', symbol: 'GBP/USD' } },
  { id: 'usdjpy', name: 'USD/JPY', aliases: ['usdjpy', 'usd/jpy', 'yen'], forex: { market: 'forex', symbol: 'USD/JPY' } },
  { id: 'audusd', name: 'AUD/USD', aliases: ['audusd', 'aud/usd', 'aussie'], forex: { market: 'forex', symbol: 'AUD/USD' } },
  { id: 'usdcad', name: 'USD/CAD', aliases: ['usdcad', 'usd/cad', 'loonie'], forex: { market: 'forex', symbol: 'USD/CAD' } },
  { id: 'usdchf', name: 'USD/CHF', aliases: ['usdchf', 'usd/chf', 'swissy'], forex: { market: 'forex', symbol: 'USD/CHF' } },
  { id: 'nzdusd', name: 'NZD/USD', aliases: ['nzdusd', 'nzd/usd', 'kiwi'], forex: { market: 'forex', symbol: 'NZD/USD' } }
];

const byAlias = new Map();
for (const inst of INSTRUMENTS) for (const a of inst.aliases) byAlias.set(a, inst);

const norm = q => (q || '').trim().toLowerCase().replace(/\s+/g, '');

// What a typed name resolves to *right now*, given whether a forex key is set.
// Returns null for anything that isn't one of these instruments so callers fall
// through to the normal exchange search.
export function resolve(query) {
  const inst = byAlias.get(norm(query));
  if (!inst) return null;
  const useForex = hasForexKey() && inst.forex;
  const pick = useForex ? inst.forex : inst.proxy;
  if (!pick) {
    // The hosted build has no .env and no server to hold a key, so pointing a
    // Pages visitor at TWELVEDATA_KEY would be advice they cannot act on.
    const onServer = typeof process !== 'undefined' && !!process.versions?.node;
    return {
      id: inst.id, name: inst.name, unavailable: true,
      reason: onServer
        ? `${inst.name} needs a free Twelve Data key — set TWELVEDATA_KEY in .env and restart`
        : `${inst.name} needs a forex feed, which only the local server can hold a key for — run the app on your machine for this one. Gold works here.`
    };
  }
  return {
    id: inst.id,
    name: inst.name,
    market: pick.market,
    symbol: pick.symbol,
    label: inst.name,
    unit: inst.unit || null,
    proxied: !useForex && !!inst.proxy,
    note: !useForex ? inst.proxy?.note : null
  };
}

// Search-result rows for the dropdown, so "gol" offers Gold before it offers
// GOLDUSDT-the-memecoin. Scored like providers.searchSymbols so the caller can
// merge both lists and sort once.
export function searchInstruments(q) {
  const term = norm(q);
  if (!term) return [];
  const out = [];
  for (const inst of INSTRUMENTS) {
    const hit = inst.aliases.some(a => a === term) ? 0
      : inst.aliases.some(a => a.startsWith(term)) ? 0.4
      : inst.name.toLowerCase().startsWith(term) ? 0.6
      : inst.aliases.some(a => a.includes(term)) ? 1.2
      : -1;
    if (hit < 0) continue;
    const r = resolve(inst.aliases[0]);
    if (!r) continue;
    // An instrument that needs a key still gets a row, marked unavailable with
    // the reason. Hiding it makes a missing key look like a missing feature,
    // and the user never learns that one line in .env turns it on.
    if (r.unavailable) {
      out.push({
        market: 'forex', symbol: inst.forex?.symbol || inst.id, base: inst.name, quote: 'USD',
        label: inst.name, instrument: inst.id, unavailable: true, reason: r.reason,
        tick: 0, score: hit + 2      // below anything actually tradeable
      });
      continue;
    }
    out.push({
      market: r.market, symbol: r.symbol, base: inst.name, quote: 'USD',
      label: r.proxied ? `${inst.name} · via ${r.symbol}` : inst.name,
      instrument: inst.id, proxied: r.proxied, note: r.note, tick: 0,
      score: hit - 1     // ahead of exchange matches at the same relevance
    });
  }
  return out;
}

// Gold is the one instrument that has to work with no key at all, so callers
// that only care about it (the news impact study, the volatility box) can ask
// directly without going through alias matching.
export const GOLD = () => resolve('gold');
