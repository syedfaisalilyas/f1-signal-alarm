// The three things the coin report could not answer from candles alone.
//
//   where is the money going   — netflow: market buys minus market sells, in
//                                dollars, bar by bar, against the price line
//   who is on which side, and
//   on which venue             — the long/short book across five exchanges,
//                                at whatever timeframe you pick
//   where would it hurt        — the liquidation map: the price shelves where
//                                leveraged positions get closed for them
//
// Two of those are measurements. The third is a model, and this file says so
// everywhere it can, because a heatmap that looks like exchange data but is
// really an assumption about leverage is the most expensive kind of chart.
//
// Everything here is free and keyless. Coinglass sells the same three panels;
// what you give up by not paying is exchange coverage — five venues here, not
// twenty — and real liquidation prints, which only Gate publishes openly.

import { fetchCandles } from './providers.js';
import { mexcSymbol } from './geofeed.js';
// Prices in these lines have to read the same as prices everywhere else in the
// report — 4,444.38, not 4444.3779 — and that convention already lives here.
import { fmtPrice } from './coinreport.js';

const FAPI = 'https://fapi.binance.com/fapi/v1';
const FDATA = 'https://fapi.binance.com/futures/data';

// Gate names contracts BASE_QUOTE, the same shape MEXC uses.
const gateContract = mexcSymbol;

const r2 = v => v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(2);
const sum = a => a.reduce((x, y) => x + (y || 0), 0);

async function jget(url, ms = 9000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'f1-alarm/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0].split('/').pop()}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// netflow — market buys minus market sells
// ─────────────────────────────────────────────────────────────────────────────
//
// Every trade has a buyer and a seller, so "more buyers than sellers" is never
// what this measures. It measures which side was in a hurry: a taker crossed
// the spread to get filled now, a maker sat and waited. Net positive means the
// impatient money was buying.
//
// Binance gives the taker buy side of each candle directly, so netflow is
// exact arithmetic, not an estimate: buys − sells = 2 × takerBuy − total.

export const NETFLOW_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h'];

export async function netflow({ market, symbol, interval = '5m', limit = 240 }) {
  if (!NETFLOW_INTERVALS.includes(interval)) interval = '5m';
  limit = Math.min(500, Math.max(30, limit));

  // Coinglass plots spot netflow, and spot is the better read: a perp print is
  // as often a hedge being opened as it is somebody buying the asset. Coins
  // that only list as a perp fall back to their own market rather than to a
  // blank panel.
  let venue = 'spot', bars;
  if (market === 'spot') {
    bars = await fetchCandles('spot', symbol, interval, limit);
  } else {
    try { bars = await fetchCandles('spot', symbol, interval, limit); }
    catch { bars = await fetchCandles(market, symbol, interval, limit); venue = 'perp'; }
  }

  // MEXC's candles carry no taker split, so a geo-blocked run has nothing to
  // plot here. Saying that beats drawing a flat line and calling it balance.
  const priced = bars.filter(b => isFinite(b.qv) && b.qv > 0 && (isFinite(b.tbq) || isFinite(b.tb)));
  if (priced.length < 10) return {
    unavailable: true, interval, venue, symbol,
    reason: 'this feed does not publish the taker buy/sell split — netflow cannot be computed from it'
  };

  const rows = priced.map(b => {
    const typical = (b.h + b.l + b.c) / 3;
    const buys = isFinite(b.tbq) ? b.tbq : b.tb * typical;   // dollars either way
    const total = b.qv;
    return { t: b.t, buys, sells: total - buys, net: 2 * buys - total, price: b.c, closed: b.closed };
  });

  const nets = rows.map(r => r.net);
  const inflow = sum(nets.filter(n => n > 0));
  const outflow = sum(nets.filter(n => n < 0));
  const net = inflow + outflow;
  const turnover = sum(rows.map(r => r.buys + r.sells));
  const green = nets.filter(n => n > 0).length;

  const out = {
    interval, venue, symbol, at: Date.now(),
    bars: rows,
    lean: null,          // filled below, once the totals it reads are built
    spanMs: rows.length > 1 ? rows.at(-1).t - rows[0].t : 0,
    totals: {
      inflow, outflow, net, turnover,
      // Netflow is a residual: on BTC it is single-digit millions against tens
      // of billions traded. Without the share, a "$40M outflow" reads as a
      // stampede when it is a rounding error on the day's turnover.
      netSharePct: turnover > 0 ? r2(net / turnover * 100) : null,
      greenBars: green, redBars: rows.length - green,
      biggest: rows.reduce((a, b) => Math.abs(b.net) > Math.abs(a.net) ? b : a, rows[0])
    }
  };
  out.lean = netflowLean(rows, out.totals);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// the long/short book, across venues
// ─────────────────────────────────────────────────────────────────────────────
//
// Two different questions get called "long/short ratio" and they disagree
// constantly, so this keeps them apart:
//
//   taker buy/sell volume — who is paying the spread right now. A flow read.
//   accounts long/short   — how many accounts sit on each side. A crowd read.
//
// Retail is almost permanently net long by account count, so 70% long accounts
// is not news. What is news is that number moving, or the two disagreeing:
// accounts piled long while takers sell is distribution into a hopeful crowd.

export const LS_PERIODS = ['5m', '15m', '30m', '1h', '4h'];

// Every venue spells the same five windows differently.
const PERIOD = {
  binance: { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h' },
  bybit: { '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h' },
  bitget: { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h' },
  gate: { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h' }
};

const pctPair = (longPart, shortPart) => {
  const t = longPart + shortPart;
  return t > 0 ? { longPct: r2(longPart / t * 100), shortPct: r2(shortPart / t * 100) } : null;
};
const fromRatio = r => isFinite(r) && r > 0 ? { longPct: r2(r / (1 + r) * 100), shortPct: r2(1 / (1 + r) * 100) } : null;

export async function longShort({ symbol, period = '1h' }) {
  if (!LS_PERIODS.includes(period)) period = '1h';
  const perp = symbol.toUpperCase();
  const gate = gateContract(perp);

  // Binance reports taker volume in coin units, so the dollar column needs a
  // price. Without it the panel still works — it just loses the $ figures.
  const [price, bnTaker, bnGlobal, bnTop, bybit, bitget, gateStat] = await Promise.all([
    jget(`${FAPI}/ticker/price?symbol=${perp}`).then(d => +d.price).catch(() => null),
    jget(`${FDATA}/takerlongshortRatio?symbol=${perp}&period=${PERIOD.binance[period]}&limit=1`).catch(() => null),
    jget(`${FDATA}/globalLongShortAccountRatio?symbol=${perp}&period=${PERIOD.binance[period]}&limit=1`).catch(() => null),
    jget(`${FDATA}/topLongShortAccountRatio?symbol=${perp}&period=${PERIOD.binance[period]}&limit=1`).catch(() => null),
    jget(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${perp}&period=${PERIOD.bybit[period]}&limit=1`).catch(() => null),
    jget(`https://api.bitget.com/api/v2/mix/market/account-long-short?symbol=${perp}&period=${PERIOD.bitget[period]}&productType=usdt-futures`).catch(() => null),
    jget(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${gate}&interval=${PERIOD.gate[period]}&limit=2`).catch(() => null)
  ]);

  // Gate stamps the current bucket before any trade lands in it, so the newest
  // row is routinely all zeros. Take the freshest one that actually has flow.
  const gateRow = Array.isArray(gateStat)
    ? [...gateStat].sort((a, b) => b.time - a.time).find(r => r.lsr_taker > 0 || r.long_users > 0) || null
    : null;

  // ── who is paying the spread ──
  const taker = [];
  const bt = Array.isArray(bnTaker) ? bnTaker.at(-1) : null;
  if (bt) {
    const buy = +bt.buyVol, sell = +bt.sellVol, p = pctPair(buy, sell);
    if (p) taker.push({
      venue: 'Binance', ...p,
      longUsd: price ? buy * price : null, shortUsd: price ? sell * price : null
    });
  }
  if (gateRow?.lsr_taker > 0) {
    const p = fromRatio(gateRow.lsr_taker);
    if (p) taker.push({ venue: 'Gate', ...p, longUsd: null, shortUsd: null });
  }

  // ── who is positioned ──
  const accounts = [];
  const bg = Array.isArray(bnGlobal) ? bnGlobal.at(-1) : null;
  if (bg) accounts.push({ venue: 'Binance', longPct: r2(+bg.longAccount * 100), shortPct: r2(+bg.shortAccount * 100) });
  const by = bybit?.result?.list?.[0];
  if (by) accounts.push({ venue: 'Bybit', longPct: r2(+by.buyRatio * 100), shortPct: r2(+by.sellRatio * 100) });
  const bgt = Array.isArray(bitget?.data) ? [...bitget.data].sort((a, b) => +b.ts - +a.ts)[0] : null;
  if (bgt) accounts.push({ venue: 'Bitget', longPct: r2(+bgt.longAccountRatio * 100), shortPct: r2(+bgt.shortAccountRatio * 100) });
  if (gateRow?.long_users > 0 || gateRow?.short_users > 0) {
    const p = pctPair(gateRow.long_users, gateRow.short_users);
    if (p) accounts.push({ venue: 'Gate', ...p });
  }

  // The top-trader book is the one worth reading against the crowd: same
  // exchange, same window, but only accounts holding real size.
  const tp = Array.isArray(bnTop) ? bnTop.at(-1) : null;
  const top = tp ? { venue: 'Binance top traders', longPct: r2(+tp.longAccount * 100), shortPct: r2(+tp.shortAccount * 100) } : null;

  const avg = rows => rows.length
    ? { longPct: r2(sum(rows.map(r => r.longPct)) / rows.length), shortPct: r2(sum(rows.map(r => r.shortPct)) / rows.length) }
    : null;

  // Only Binance publishes taker volume in dollars, so only Binance can be
  // weighted by size. Averaging its book with a venue a hundredth the size
  // would read as "the market is 44% long" on the strength of the small one,
  // so the summary row names the venues it actually covers instead of
  // pretending to speak for all of them.
  const usdRows = taker.filter(r => r.longUsd != null);
  const takerAll = !taker.length ? null : usdRows.length
    ? { ...pctPair(sum(usdRows.map(r => r.longUsd)), sum(usdRows.map(r => r.shortUsd))),
        longUsd: sum(usdRows.map(r => r.longUsd)), shortUsd: sum(usdRows.map(r => r.shortUsd)),
        weighted: true, venueNames: usdRows.map(r => r.venue) }
    : { ...avg(taker), longUsd: null, shortUsd: null, weighted: false, venueNames: taker.map(r => r.venue) };
  const accountsAll = accounts.length
    ? { ...avg(accounts), venues: accounts.length, venueNames: accounts.map(r => r.venue) }
    : null;

  return {
    symbol: perp, period, at: Date.now(), price,
    taker, takerAll, accounts, accountsAll, top,
    lean: longShortLean(takerAll, accountsAll),
    read: reading(takerAll, accountsAll, top),
    venuesMissing: ['Binance', 'Bybit', 'Bitget', 'Gate']
      .filter(v => !taker.some(r => r.venue === v) && !accounts.some(r => r.venue === v))
  };
}

// What the two halves mean together — stated only when they actually say
// something. A crowd leaning long while takers buy is a trend, not a fade.
function reading(takerAll, accountsAll, top) {
  const out = [];
  if (takerAll) out.push(
    takerAll.longPct >= 55 ? `${takerAll.longPct}% of taker volume is hitting the offer — buyers are the impatient side`
      : takerAll.longPct <= 45 ? `${takerAll.shortPct}% of taker volume is hitting the bid — sellers are the impatient side`
      : 'taker flow is near even — neither side is paying up to get filled');
  if (accountsAll) out.push(
    `${accountsAll.longPct}% of accounts across ${accountsAll.venues} venue${accountsAll.venues === 1 ? '' : 's'} are long. ` +
    'Retail sits net long almost always, so the level matters less than where it has moved from.');
  if (takerAll && accountsAll) {
    if (accountsAll.longPct >= 60 && takerAll.longPct <= 47)
      out.push('The crowd is long while the flow sells into it — that gap is what distribution looks like from the outside.');
    else if (accountsAll.longPct <= 45 && takerAll.longPct >= 53)
      out.push('The crowd is short while the flow buys it up — the squeeze fuel is the crowd itself.');
  }
  if (top && accountsAll && Math.abs(top.longPct - accountsAll.longPct) >= 12)
    out.push(`Top traders are ${top.longPct}% long against the crowd's ${accountsAll.longPct}% — the accounts with size are on the other side of the retail book.`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// the liquidation map
// ─────────────────────────────────────────────────────────────────────────────
//
// READ THIS BEFORE TRUSTING THE PICTURE. No exchange publishes where open
// positions get liquidated — that is private to their risk engine. Every
// liquidation heatmap you have seen, this one and Coinglass's alike, is a
// model. What is real underneath it is only the candles.
//
// The model: volume traded at a price is positions opened at that price. Split
// it across the leverage most people actually use, and each slice implies a
// liquidation price — 10× longs die 10% below entry, 100× longs 1% below. Add
// those up over the window and clusters appear: prices where a lot of leverage
// would be force-closed at once.
//
// The clearing rule is what makes it worth drawing. When price later trades
// through a cluster, those positions are gone, so the band is wiped from that
// point on. What is left on screen is untouched leverage — and price does tend
// to travel toward it, because a forced close is a market order somebody else
// gets to trade against.
//
// It is still a model. Treat a bright band as "a lot of stops probably live
// here", never as a fact about anyone's book.

// Every window uses a candle both Binance and MEXC serve natively, so the map
// comes off the perp wherever the process is running — a window built on an
// interval only one venue has would silently fall through to spot in the other
// region and be labelled as if the coin had no perp. The short ones are thin
// by nature: five one-minute bars is five columns, and the bands it shows are
// only the leverage taken on in those five minutes.
export const LIQ_WINDOWS = {
  '5m': { interval: '1m', limit: 5, label: '5 minute' },
  '15m': { interval: '1m', limit: 15, label: '15 minute' },
  '30m': { interval: '1m', limit: 30, label: '30 minute' },
  '1h': { interval: '1m', limit: 60, label: '1 hour' },
  '2h': { interval: '1m', limit: 120, label: '2 hour' },
  '4h': { interval: '1m', limit: 240, label: '4 hour' },
  '6h': { interval: '5m', limit: 72, label: '6 hour' },
  '12h': { interval: '5m', limit: 144, label: '12 hour' },
  '24h': { interval: '15m', limit: 96, label: '24 hour' },
  '3d': { interval: '30m', limit: 144, label: '3 day' },
  '1w': { interval: '1h', limit: 168, label: '1 week' },
  '2w': { interval: '4h', limit: 84, label: '2 week' },
  '1M': { interval: '4h', limit: 180, label: '1 month' }
};

// The leverage retail actually runs, and roughly how it splits. These weights
// are a judgement call, not a measurement — they set how bright the near bands
// are against the far ones, and nothing else.
const TIERS = [
  { lev: 10, weight: 0.25 },
  { lev: 25, weight: 0.30 },
  { lev: 50, weight: 0.25 },
  { lev: 100, weight: 0.20 }
];
const PRICE_BUCKETS = 100;

export async function liquidationMap({ symbol, window = '12h' }) {
  const w = LIQ_WINDOWS[window] || LIQ_WINDOWS['12h'];
  // Leverage lives on the perp, so the map is built from perp candles wherever
  // one exists — a spot report of a coin that also trades as a perp should
  // still show the perp's shelves. Spot is the fallback for pairs with no perp
  // anywhere, where the model is weaker and the panel says so.
  let venue = 'perp', raw;
  try { raw = await fetchCandles('futures', symbol, w.interval, w.limit); }
  catch { raw = await fetchCandles('spot', symbol, w.interval, w.limit); venue = 'spot'; }
  const bars = raw.slice(-w.limit);
  // A window is unusable when the feed handed back well under what it asked
  // for — twelve bars for the long ones, most of the window for the short.
  if (bars.length < Math.min(12, Math.ceil(w.limit * 0.6)))
    return { unavailable: true, window, reason: 'not enough candles in this window' };

  // The grid has to reach past the candles far enough to hold the bands, and
  // no further: give it the full ±10% a 10× position implies and a quiet BTC
  // session becomes a hairline of candles across an empty map. One and a half
  // times the window's own range, floored at 3.5%, keeps the 100× and 50×
  // shelves on screen and still leaves the price action readable. Bands that
  // fall outside are dropped rather than squeezed in — they are too far away
  // to pull price this week anyway.
  const lowest = Math.min(...bars.map(b => b.l)), highest = Math.max(...bars.map(b => b.h));
  const pad = Math.max((highest - lowest) * 1.5, highest * 0.035);
  const lo = lowest - pad, hi = highest + pad;
  const step = (hi - lo) / PRICE_BUCKETS;
  const bucket = p => Math.floor((p - lo) / step);
  const prices = Array.from({ length: PRICE_BUCKETS }, (_, i) => lo + step * (i + 0.5));

  // Long and short leverage are tracked apart, even though the heatmap paints
  // their sum. Which side dies at a shelf is the whole directional read: a
  // shelf of shorts is forced BUYING when it goes, a shelf of longs is forced
  // selling. Adding them first and guessing the side back from geometry gets
  // that wrong every time the window has trended.
  const openL = new Float64Array(PRICE_BUCKETS);
  const openS = new Float64Array(PRICE_BUCKETS);
  const grid = [];
  let cleared = 0;

  for (const b of bars) {
    // 1. anything this candle traded through has already been liquidated.
    const from = Math.max(0, bucket(b.l)), to = Math.min(PRICE_BUCKETS - 1, bucket(b.h));
    for (let i = from; i <= to; i++) { cleared += openL[i] + openS[i]; openL[i] = 0; openS[i] = 0; }

    // 2. positions opened inside this candle. Which side opened is read from
    //    the taker split when the feed has one — the impatient side is the one
    //    taking on leverage — and split evenly when it does not.
    const notional = isFinite(b.qv) && b.qv > 0 ? b.qv : b.v * b.c;
    const longShare = isFinite(b.tb) && b.v > 0 ? Math.min(0.85, Math.max(0.15, b.tb / b.v)) : 0.5;
    const entry = (b.h + b.l + b.c) / 3;
    for (const t of TIERS) {
      const longLiq = bucket(entry * (1 - 1 / t.lev));
      const shortLiq = bucket(entry * (1 + 1 / t.lev));
      if (longLiq >= 0 && longLiq < PRICE_BUCKETS) openL[longLiq] += notional * t.weight * longShare;
      if (shortLiq >= 0 && shortLiq < PRICE_BUCKETS) openS[shortLiq] += notional * t.weight * (1 - longShare);
    }

    grid.push(Float64Array.from(openL, (v, i) => v + openS[i]));
  }

  const peak = Math.max(...grid.map(col => Math.max(...col)));
  // Sent as 0–100 per cell. A byte of precision is more than a screen can
  // paint, and the alternative is a megabyte of float JSON per coin.
  const cols = grid.map(col => Array.from(col, v => peak > 0 ? Math.round(v / peak * 100) : 0));

  // Where the surviving leverage sits now, as levels you can actually name.
  const last = grid.at(-1);
  const price = bars.at(-1).c;
  const shelves = Array.from(last, (v, i) => ({ price: prices[i], mag: v, longs: openL[i], shorts: openS[i] }))
    .filter(x => x.mag > peak * 0.12)
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 6)
    .map(x => ({
      price: +x.price.toPrecision(8),
      distPct: r2((x.price - price) / price * 100),
      intensity: Math.round(x.mag / peak * 100),
      usd: Math.round(x.mag),
      side: x.price < price ? 'below' : 'above',
      // Whose stops are these. A shelf can hold both — the majority is what
      // moves price when it goes.
      kind: x.shorts > x.longs ? 'shorts' : 'longs',
      shortSharePct: x.mag > 0 ? r2(x.shorts / x.mag * 100) : null
    }))
    .sort((a, b) => b.price - a.price);

  return {
    window, windowLabel: w.label, interval: w.interval, symbol, venue, at: Date.now(),
    price, lo, hi, buckets: PRICE_BUCKETS,
    prices: prices.map(p => +p.toPrecision(8)),
    times: bars.map(b => b.t),
    candles: bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c })),
    cols, peakUsd: Math.round(peak), clearedUsd: Math.round(cleared),
    shelves, lean: liqLean(shelves, price),
    actual: await gateLiquidations(symbol).catch(() => null)
  };
}

// The one real liquidation number available without a paid feed. Gate posts
// what actually got force-closed on its own book, hour by hour. It is one
// venue out of dozens, so it undercounts badly — but it is measured, and it
// belongs next to a model for exactly that reason.
async function gateLiquidations(symbol) {
  const rows = await jget(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${gateContract(symbol)}&interval=1h&limit=24`);
  if (!Array.isArray(rows) || !rows.length) return null;
  const longUsd = sum(rows.map(r => +r.long_liq_usd_new || +r.long_liq_usd || 0));
  const shortUsd = sum(rows.map(r => +r.short_liq_usd_new || +r.short_liq_usd || 0));
  if (!(longUsd + shortUsd > 0)) return null;
  return { venue: 'Gate', hours: rows.length, longUsd, shortUsd };
}

// ─────────────────────────────────────────────────────────────────────────────
// which way each panel points
// ─────────────────────────────────────────────────────────────────────────────
//
// Each panel states a fact and leaves the reader to draw the arrow. These draw
// it. One line, one direction, and the mechanism named — because the mechanism
// is the part that tells you when the line stops being true.
//
// They are single-indicator reads, deliberately. Three panels leaning the same
// way is worth something; one of them leaning on its own is a hint, and the
// report's own verdict at the top of the page is still the one that weighs
// everything together.

const lean = (dir, text) => ({ dir, text });

// Netflow: does the money agree with the candle? Flow that confirms price is a
// trend; flow that fights it is absorption, and absorption is the one that
// pays, because it front-runs the turn rather than the continuation.
function netflowLean(rows, totals) {
  const first = rows[0].price, last = rows.at(-1).price;
  const pxChg = first > 0 ? (last - first) / first * 100 : 0;
  const share = totals.netSharePct ?? 0;
  const moved = Math.abs(pxChg) >= 0.15;
  const priceUp = moved && pxChg > 0, priceDown = moved && pxChg < 0;

  // Under half a percent of turnover is a rounding error on the day, not a side.
  if (Math.abs(share) < 0.5) return lean('FLAT',
    `Net flow is ${share}% of everything traded here — inside the noise. There is no direction in this panel right now.`);

  if (share > 0) return priceDown
    ? lean('UP', `Price is DOWN ${Math.abs(r2(pxChg))}% while market buyers keep paying the spread — net +${share}% of turnover. Sellers are being absorbed, and that leans UP.`)
    : lean('UP', `Buyers are the ones paying up — net +${share}% of turnover${priceUp ? ` with price up ${r2(pxChg)}%` : ''}. Flow is behind the move: UP.`);

  return priceUp
    ? lean('DOWN', `Price is UP ${r2(pxChg)}% on net selling — ${share}% of turnover. The rally has no sponsorship behind it, which leans DOWN.`)
    : lean('DOWN', `Sellers are the ones paying up — ${share}% of turnover${priceDown ? ` with price down ${Math.abs(r2(pxChg))}%` : ''}. Flow is behind the move: DOWN.`);
}

// The book: the crowd is the fade, the flow is the follow.
//
// The crowd read is contrarian for a reason worth stating — a crowded side is
// not wrong, it is ALREADY IN. It has no buying left to do and a stop under it,
// so the path of least resistance runs the other way. Retail sits net long
// almost permanently, which is why 60% is the line here and not 50%.
function longShortLean(takerAll, accountsAll) {
  const crowd = accountsAll?.longPct, flow = takerAll?.longPct;
  if (crowd == null && flow == null) return null;

  if (crowd != null && crowd >= 60) return flow != null && flow <= 50
    ? lean('DOWN', `${crowd}% of accounts are long and the flow is selling into them (${r2(100 - flow)}% of taker volume). Crowded side, no bid behind it — the fade is DOWN.`)
    : lean('DOWN', `${crowd}% of accounts are already long. A side that is already in has nothing left to buy and a stop underneath it — the fade is DOWN.`);

  if (crowd != null && crowd <= 45) return flow != null && flow >= 50
    ? lean('UP', `${r2(100 - crowd)}% of accounts are short and the flow is buying it up (${flow}% of taker volume). Every one of those shorts has to buy to get out — that is squeeze fuel: UP.`)
    : lean('UP', `${r2(100 - crowd)}% of accounts are short. Getting out means buying, which is the fuel a squeeze runs on — the lean is UP.`);

  if (flow != null && flow >= 55) return lean('UP',
    `The book is balanced${crowd != null ? ` (${crowd}% long)` : ''}, so the flow decides: ${flow}% of taker volume is lifting the offer. UP.`);
  if (flow != null && flow <= 45) return lean('DOWN',
    `The book is balanced${crowd != null ? ` (${crowd}% long)` : ''}, so the flow decides: ${r2(100 - flow)}% of taker volume is hitting the bid. DOWN.`);

  return lean('FLAT',
    `${crowd != null ? `${crowd}% of accounts long` : 'The book'} and taker flow near even — nobody is crowded and nobody is paying up. No edge in this panel.`);
}

// The map: price goes where the stops are, and the nearest heavy shelf wins
// over a bigger one further away — hence pull, not size.
//
// Which side dies there is what sets the direction, and it is not the same as
// which side of price it sits on: a shelf of SHORTS going means forced buying,
// wherever it sits.
function liqLean(shelves, price) {
  if (!shelves.length) return lean('FLAT', 'No cluster survived nearby — there is nothing pulling price in this window.');
  const pull = s => s.intensity / Math.max(0.35, Math.abs(s.distPct));
  const best = side => shelves.filter(s => s.side === side).sort((a, b) => pull(b) - pull(a))[0] || null;
  const up = best('above'), down = best('below');

  const say = (s, dir) => lean(dir,
    `Nearest heavy shelf is ${fmtPrice(s.price)} — ${s.distPct >= 0 ? '+' : ''}${s.distPct}% away, and it is where ${s.kind} get force-closed. ` +
    `That is forced ${s.kind === 'shorts' ? 'BUYING' : 'SELLING'} once price reaches it, so the pull is ${dir}.`);

  if (up && !down) return say(up, up.kind === 'shorts' ? 'UP' : 'DOWN');
  if (down && !up) return say(down, down.kind === 'shorts' ? 'UP' : 'DOWN');

  const pu = pull(up), pd = pull(down);
  // Within a quarter of each other the map is a tug of war, and saying so is
  // more useful than calling a coin flip.
  if (Math.max(pu, pd) < Math.min(pu, pd) * 1.25) return lean('FLAT',
    `Price is sitting between two shelves of roughly equal pull — ${fmtPrice(down.price)} below and ${fmtPrice(up.price)} above. ` +
    'Whichever breaks first, the other becomes the target; there is no lean until one goes.');

  const win = pu > pd ? up : down;
  return say(win, win.kind === 'shorts' ? 'UP' : 'DOWN');
}
