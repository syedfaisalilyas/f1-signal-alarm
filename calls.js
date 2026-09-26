#!/usr/bin/env node
// A+ trade calls for gold, forex and crypto — and whether the money agrees.
//
// Runs after scan.js on the 5-minute GitHub Action and writes cloud/calls.json,
// which is published on the state branch and read by docs/calls.html.
//
// A call has two halves:
//   1. The zone. The A+ pullback rules from tools/mt5/gold-aplus.mjs: H1, M15
//      and M5 trend agree, price pulls back into the EMA20 zone after a fresh
//      impulse, ATR is awake, no news within 20 min. "Watching" = price is in
//      the zone, waiting for a strong 5m close. "Ready" = that close happened:
//      entry, stop and a 2.5R target.
//   2. Everything else. Big funds (CFTC COT), small traders (COT non-reportable
//      / exchange long-short accounts), ETF or taker money flow, the dollar,
//      bond yields, funding, open interest and the calendar. Each one leans
//      bullish, bearish or neutral on the asset; the page shows whether that
//      lean agrees with or opposes the call.
//
// Calls are tracked until TP, SL or 24 h, so the page can show a real win rate.
//
// Crypto = every USDT perpetual listed on BOTH MEXC and Binance (~500 coins).
// Candles come from MEXC (Binance answers 451 to GitHub's US runners); the
// Binance list is fetched live when it answers, else read from
// cloud/binance-perps.json. Full sentiment is fetched only for the coins that
// are lined up (and the majors), to keep a run inside a minute.
//
// Sources (no API keys): Dukascopy chart feed (spot gold + FX + US T-bond),
// MEXC contract API (crypto candles + board), Gate.io futures (funding,
// positioning), CFTC Socrata (COT), Nasdaq (GLD daily), ForexFactory calendar.

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'cloud');
const OUT = path.join(DIR, 'calls.json');
const RR = 2.5;
const EXPIRE_MS = 24 * 3600e3;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';

// ─── markets ───
// min/max = allowed stop distance in price; buf = stop buffer past the swing.
// cot = CFTC contract code; cotInv = the COT contract is the other side of the pair.
const pip = (p, n) => p * n;
const fx = (id, cot, inv, jpy = false) => ({
  id, cls: 'forex', src: 'duka', inst: `${id.slice(0, 3)}/${id.slice(3)}`, dp: jpy ? 3 : 5,
  min: pip(jpy ? 0.01 : 0.0001, 8), max: pip(jpy ? 0.01 : 0.0001, 30), buf: jpy ? 0.01 : 0.0001,
  news: [id.slice(0, 3), id.slice(3)], sess: [7, 17], cot, cotInv: inv, usdSide: id.startsWith('USD') ? 1 : -1
});
const MAJORS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];
const NOT_CRYPTO = /^(XAU|XAG|XPT|XPD|PAXG|XAUT)/;
const MARKETS = [
  { id: 'XAUUSD', name: 'Gold', cls: 'gold', src: 'duka', inst: 'XAU/USD', dp: 2, min: 5, max: 15, buf: 0.5, news: ['USD'], cot: '088691', usdSide: -1 },
  fx('EURUSD', '099741', false), fx('GBPUSD', '096742', false), fx('AUDUSD', '232741', false),
  fx('NZDUSD', '112741', false), fx('USDJPY', '097741', true, true), fx('USDCAD', '090741', true),
  fx('USDCHF', '092741', true)
].map(m => ({ ...m, tv: `OANDA:${m.id}` }));

// Every USDT perp on both exchanges, biggest 24h turnover first.
async function cryptoUniverse() {
  let binance;
  try {
    const info = await get('https://fapi.binance.com/fapi/v1/exchangeInfo', { ms: 10000 });
    binance = info.symbols.filter(x => x.contractType === 'PERPETUAL' && x.status === 'TRADING' && x.quoteAsset === 'USDT').map(x => x.symbol);
    fs.writeFileSync(path.join(DIR, 'binance-perps.json'), JSON.stringify({ updated: new Date().toISOString().slice(0, 10), symbols: binance.sort() }));
  } catch {
    binance = JSON.parse(fs.readFileSync(path.join(DIR, 'binance-perps.json'), 'utf8')).symbols;
  }
  const bset = new Set(binance);
  const [detail, tickers] = await Promise.all([
    get('https://contract.mexc.com/api/v1/contract/detail'),
    get('https://contract.mexc.com/api/v1/contract/ticker')
  ]);
  const turnover = Object.fromEntries((tickers.data || []).map(t => [t.symbol, +t.amount24 || 0]));
  return detail.data
    .filter(x => x.quoteCoin === 'USDT' && x.state === 0 && bset.has(x.symbol.replace('_', '')) && !NOT_CRYPTO.test(x.baseCoin))
    .map(x => {
      const id = x.symbol.replace('_', ''), dp = Math.max(0, Math.round(-Math.log10(+x.priceUnit || 0.01)));
      return {
        id, name: x.baseCoin, cls: 'crypto', src: 'mexc', msym: x.symbol, contract: x.symbol, dp,
        minPct: 0.0015, maxPct: 0.012, news: ['USD'], tv: `BINANCE:${id}.P`,
        turnover: turnover[x.symbol] || 0, major: MAJORS.includes(id)
      };
    })
    .sort((a, b) => b.major - a.major || b.turnover - a.turnover);
}

// ─── fetch helpers ───
async function get(url, { text = false, headers = {}, ms = 20000 } = {}) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': UA, ...headers } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return text ? r.text() : r.json();
    } catch (e) {
      if (t === 2) throw e;
      await new Promise(z => setTimeout(z, 1500 * (t + 1)));
    }
  }
}

const PER = { '5m': 300, '15m': 900, '1h': 3600 };
const DUKA_TF = { '5m': '5MIN', '15m': '15MIN', '1h': '1HOUR' };

async function dukaBars(inst, tf, limit) {
  const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=' + encodeURIComponent(inst) +
    `&offer_side=B&interval=${DUKA_TF[tf]}&splits=true&stocks=true&limit=${limit}&time_direction=P&timestamp=${Date.now()}&jsonp=_cb`;
  const body = await get(url, { text: true, headers: { Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' } });
  const rows = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))).filter(Boolean);
  return closed(rows.map(r => ({ t: r[0] / 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })), tf);
}

// oldest first, unfinished bar dropped
function closed(bars, tf) {
  const now = Date.now() / 1000;
  return bars.sort((a, b) => a.t - b.t).filter(b => b.t + PER[tf] <= now + 5);
}

// One request per coin: 1000 5m bars, rolled up into 15m and 1h locally.
// MEXC allows ~20 requests / 2 s and answers "too frequent" with HTTP 200 and
// success:false, so requests are spaced and that reply is retried.
let mexcNext = 0;
async function mexcGet(url) {
  for (let t = 0; t < 5; t++) {
    const wait = Math.max(0, mexcNext - Date.now());
    mexcNext = Math.max(Date.now(), mexcNext) + 110;
    if (wait) await new Promise(z => setTimeout(z, wait));
    const j = await get(url);
    if (j?.success !== false) return j;
    await new Promise(z => setTimeout(z, 1000 * (t + 1)));
  }
  throw new Error('mexc: too frequent');
}
async function mexcBars(sym) {
  const d = (await mexcGet(`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min5&start=${Math.floor(Date.now() / 1000) - 1000 * 300}`)).data;
  if (!d?.time?.length) return [];
  return closed(d.time.map((t, i) => ({ t, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], v: +d.vol[i] })), '5m');
}
function rollup(m5, sec) {
  const out = [];
  for (const b of m5) {
    const t = b.t - b.t % sec, last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; last.n++; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1 });
  }
  const full = sec / 300;                                    // drop a half-built last bucket
  if (out.length && out.at(-1).n < full) out.pop();
  return out;
}

async function barsFor(m) {
  if (m.src === 'duka') {
    const [m5, m15, h1] = await Promise.all([dukaBars(m.inst, '5m', 600), dukaBars(m.inst, '15m', 300), dukaBars(m.inst, '1h', 300)]);
    return { m5, m15, h1 };
  }
  const m5 = await mexcBars(m.msym);
  return { m5, m15: rollup(m5, 900), h1: rollup(m5, 3600) };
}

// run fn over items, n at a time
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ─── indicators (same as tools/mt5/gold-aplus.mjs) ───
const ema = (a, n) => { const k = 2 / (n + 1), out = []; a.forEach((v, i) => out.push(i ? v * k + out[i - 1] * (1 - k) : v)); return out; };
function atrAt(b, end, n = 14) {
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  return s / n;
}
function trend(b) {
  const c = b.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), i = c.length - 1;
  if (e20[i] > e50[i] && c[i] > e50[i] && e20[i] > e20[i - 5]) return 1;
  if (e20[i] < e50[i] && c[i] < e50[i] && e20[i] < e20[i - 5]) return -1;
  return 0;
}
function pivots(b, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < b.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (b[j].h > b[i].h) isH = false; if (b[j].l < b[i].l) isL = false; }
    if (isH) hi.push(b[i].h);
    if (isL) lo.push(b[i].l);
  }
  return { hi, lo };
}

// ─── the A+ zone ───
function aplus(m, { m5, m15, h1 }, newsNear, nowSec = Date.now() / 1000) {
  const i = m5.length - 1, last = m5[i], now = last.c;
  const tH = trend(h1), tM = trend(m15), t5 = trend(m5);
  const c = m5.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), A = atrAt(m5, i);
  const atrs = []; for (let k = i - 199; k <= i; k++) atrs.push(atrAt(m5, k));
  const medAtr = atrs.sort((a, b) => a - b)[100], live = A >= 0.7 * medAtr;
  const hr = new Date(nowSec * 1000).getUTCHours() + new Date(nowSec * 1000).getUTCMinutes() / 60;
  const inSess = !m.sess || (hr >= m.sess[0] && hr < m.sess[1]);
  const fresh = nowSec - last.t < 30 * 60;                            // market open
  const piv = pivots(m5);
  const base = { trend: { h1: tH, m15: tM, m5: t5 }, price: now, atr: A, volRatio: A / medAtr, live, inSess, fresh, ema20: e20[i] };

  const min = m.min ?? now * m.minPct, max = m.max ?? now * m.maxPct, buf = m.buf ?? A * 0.1;
  for (const d of [1, -1]) {
    const aligned = tH === d && tM === d && t5 === d;
    if (!aligned) continue;
    const structOk = d > 0 ? now > (piv.lo.at(-1) ?? -Infinity) : now < (piv.hi.at(-1) ?? Infinity);
    const touched = m5.slice(-3).some(b => d > 0 ? b.l <= e20[i] + 0.3 * A : b.h >= e20[i] - 0.3 * A);
    const holdsE50 = d > 0 ? now > e50[i] : now < e50[i];
    const impulse = [...Array(15).keys()].some(k => {
      const j = i - k, w = m5.slice(j - 30, j);
      return d > 0 ? m5[j].h > Math.max(...w.map(b => b.h)) : m5[j].l < Math.min(...w.map(b => b.l));
    });
    const zone = [e20[i] - 0.3 * A, e20[i] + 0.3 * A];
    const blockers = [];
    if (!structOk) blockers.push('5m structure broke');
    if (!holdsE50) blockers.push('lost EMA50');
    if (!impulse) blockers.push('no fresh impulse');
    if (!live) blockers.push('market too quiet');
    if (!inSess) blockers.push('outside session');
    if (!fresh) blockers.push('market closed');
    if (newsNear) blockers.push(`news: ${newsNear.title}`);
    if (!touched) return { ...base, status: 'trend', side: d, zone, blockers: ['waiting for pullback into zone', ...blockers] };
    if (blockers.length) return { ...base, status: 'trend', side: d, zone, blockers };

    const prev = m5[i - 1], rng = last.h - last.l || 1e-9, body = (last.c - last.o) * d;
    const reject = body > 0 && body / rng >= 0.5 && rng >= 0.6 * A && (last.c - e20[i]) * d > 0 && (d > 0 ? last.c > prev.h : last.c < prev.l);
    const swing = d > 0 ? Math.min(...m5.slice(-5).map(b => b.l)) - buf : Math.max(...m5.slice(-5).map(b => b.h)) + buf;
    const dist = Math.max(Math.abs(now - swing), A, min), sl = now - d * dist, tp = now + d * RR * dist;
    const hp = pivots(h1, 2);
    const lvl = d > 0 ? hp.hi.filter(x => x > now + dist * 0.2).sort((a, b) => a - b)[0]
                      : hp.lo.filter(x => x < now - dist * 0.2).sort((a, b) => b - a)[0];
    const room = lvl ? Math.abs(lvl - now) / dist : Infinity;
    if (reject && dist <= max && dist <= 2.2 * A && room >= RR)
      return { ...base, status: 'ready', side: d, zone, entry: now, sl, tp, barT: last.t };
    const why = !reject ? 'waiting for a strong 5m close out of the zone' : dist > max || dist > 2.2 * A ? 'stop would be too wide' : 'H1 level too close for 2.5R';
    return { ...base, status: 'watching', side: d, zone, blockers: [why] };
  }
  return { ...base, status: 'none', side: 0, blockers: ['H1, M15 and M5 trends do not agree'] };
}

// ─── sentiment inputs, fetched once per run ───
async function cot(codes) {
  const list = codes.map(c => `'${c}'`).join(',');
  const url = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=' + encodeURIComponent(`cftc_contract_market_code in(${list})`) +
    '&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=' + codes.length * 3 +
    '&$select=cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,nonrept_positions_long_all,nonrept_positions_short_all';
  const rows = await get(url);
  const by = {};
  for (const r of rows) (by[r.cftc_contract_market_code] ??= []).push(r);
  const out = {};
  for (const [code, rs] of Object.entries(by)) {
    const [a, b] = rs;
    const net = r => +r.noncomm_positions_long_all - +r.noncomm_positions_short_all;
    out[code] = {
      date: a.report_date_as_yyyy_mm_dd.slice(0, 10),
      fundsLong: +a.noncomm_positions_long_all, fundsShort: +a.noncomm_positions_short_all,
      fundsNet: net(a), fundsChg: b ? net(a) - net(b) : 0,
      smallLong: +a.nonrept_positions_long_all, smallShort: +a.nonrept_positions_short_all
    };
  }
  return out;
}

async function gldFlow() {
  const from = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  const j = await get(`https://api.nasdaq.com/api/quote/GLD/historical?assetclass=etf&fromdate=${from}&limit=15`, { headers: { Accept: 'application/json' } });
  const rows = j.data.tradesTable.rows.map(r => ({ c: +r.close.replace(/[$,]/g, ''), v: +r.volume.replace(/,/g, '') })).reverse();
  const last = rows.slice(-6);
  let up = 0, all = 0;
  for (let k = 1; k < last.length; k++) { const v = last[k].v * last[k].c; all += v; if (last[k].c > last[k - 1].c) up += v; else up -= v; }
  const avg = rows.reduce((s, r) => s + r.v, 0) / rows.length;
  return { flow: all ? up / all : 0, volVsAvg: last.at(-1).v / avg };
}

// ICE dollar index from the six majors, 1h bars
async function dollar() {
  const W = { 'EUR/USD': -0.576, 'USD/JPY': 0.136, 'GBP/USD': -0.119, 'USD/CAD': 0.091, 'USD/SEK': 0.042, 'USD/CHF': 0.036 };
  const series = await Promise.all(Object.keys(W).map(k => dukaBars(k, '1h', 60)));
  const n = Math.min(...series.map(s => s.length));
  const dxy = [];
  for (let k = 0; k < n; k++) {
    let v = 50.14348112;
    Object.values(W).forEach((w, j) => { v *= Math.pow(series[j][series[j].length - n + k].c, w); });
    dxy.push(v);
  }
  return { now: dxy.at(-1), chg24: dxy.at(-1) / dxy.at(-25) - 1, trend: trend(dxy.map(c => ({ c }))) };
}

async function bonds() {
  const b = await dukaBars('USTBOND.TR/USD', '1h', 60);
  return { chg24: b.at(-1).c / b.at(-25).c - 1 };
}

async function calendar() {
  const all = await get('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  return all.filter(e => e.impact === 'High' || e.impact === 'Medium');
}

async function cryptoFlow(contract) {
  const [stats, info] = await Promise.all([
    get(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${contract}&interval=1h&limit=5`),
    get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${contract}`)
  ]);
  const s = stats.sort((a, b) => a.time - b.time), last = s.at(-1), first = s[0];
  const taker = s.slice(-4).reduce((a, r) => a + r.lsr_taker, 0) / Math.min(4, s.length);
  return {
    funding: +info.funding_rate, accounts: last.lsr_account, taker,
    oiChg: first.open_interest_usd ? last.open_interest_usd / first.open_interest_usd - 1 : 0,
    priceChg: first.mark_price ? last.mark_price / first.mark_price - 1 : 0,
    longLiq: s.slice(-4).reduce((a, r) => a + (r.long_liq_usd || 0), 0),
    shortLiq: s.slice(-4).reduce((a, r) => a + (r.short_liq_usd || 0), 0)
  };
}

// ─── leans: +1 bullish for the asset, -1 bearish, 0 neutral ───
const k = n => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const pct = (x, dp = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(dp) + '%';

function checksFor(m, ctx) {
  const out = [];
  const add = (key, label, lean, text, extra = {}) => out.push({ key, label, lean, text, ...extra });

  if (m.cot && ctx.cot?.[m.cot]) {
    const c = ctx.cot[m.cot], inv = m.cotInv ? -1 : 1;
    const base = m.cotInv ? m.id.slice(3) : m.id.slice(0, 3) === 'XAU' ? 'gold' : m.id.slice(0, 3);
    // which side funds are on, unless this week they moved hard the other way
    const turning = Math.sign(c.fundsChg) !== Math.sign(c.fundsNet) && Math.abs(c.fundsChg) > 0.1 * Math.abs(c.fundsNet);
    const lean = turning ? Math.sign(c.fundsChg) : Math.sign(c.fundsNet);
    add('funds', 'Big funds (COT)', lean * inv,
      `Funds net ${c.fundsNet >= 0 ? 'long' : 'short'} ${base} ${k(Math.abs(c.fundsNet))} contracts, ${c.fundsChg >= 0 ? '+' : '−'}${k(Math.abs(c.fundsChg))} this week`,
      { asOf: c.date });
    const share = c.smallLong / (c.smallLong + c.smallShort);
    const crowd = share > 0.6 ? -1 : share < 0.4 ? 1 : 0;           // the crowd is usually late
    add('crowd', 'Small traders (COT)', crowd * inv,
      `${Math.round(share * 100)}% of small traders long ${base}${crowd ? ' — crowd leaning, fade it' : ' — balanced'}`, { asOf: c.date });
  }

  if (m.cls === 'gold' && ctx.gld) {
    const g = ctx.gld, lean = g.flow > 0.2 ? 1 : g.flow < -0.2 ? -1 : 0;
    add('etf', 'Gold ETF money (GLD)', lean,
      `5-day volume flow ${lean > 0 ? 'into' : lean < 0 ? 'out of' : 'flat on'} GLD (${pct(g.flow, 0)}), last day ${g.volVsAvg.toFixed(1)}× avg volume`);
  }

  if (m.usdSide && ctx.dxy) {
    const d = ctx.dxy, usd = d.trend || (d.chg24 > 0.002 ? 1 : d.chg24 < -0.002 ? -1 : 0);
    add('dollar', 'US dollar (DXY)', usd * m.usdSide,
      `DXY ${d.now.toFixed(2)}, ${pct(d.chg24, 2)} in 24h, ${usd > 0 ? 'rising' : usd < 0 ? 'falling' : 'flat'}`);
  }

  if (ctx.bonds && (m.cls === 'gold' || m.id === 'USDJPY')) {
    const b = ctx.bonds.chg24, yields = b < -0.001 ? 1 : b > 0.001 ? -1 : 0;      // bond price down = yields up
    const lean = m.cls === 'gold' ? -yields : yields;
    add('yields', 'US yields', lean, `T-bond ${pct(b, 2)} in 24h — yields ${yields > 0 ? 'rising' : yields < 0 ? 'falling' : 'flat'}`);
  }

  if (m.cls === 'crypto' && ctx.flow?.[m.id]) {
    const f = ctx.flow[m.id];
    add('taker', 'Taker money flow (4h)', f.taker > 1.1 ? 1 : f.taker < 0.9 ? -1 : 0,
      `Aggressive buyers vs sellers ${f.taker.toFixed(2)}×${f.taker > 1.1 ? ' — buyers in control' : f.taker < 0.9 ? ' — sellers in control' : ''}`);
    add('crowd', 'Crowd long/short (accounts)', f.accounts > 1.3 ? -1 : f.accounts < 0.85 ? 1 : 0,
      `${f.accounts.toFixed(2)} long accounts per short${f.accounts > 1.3 ? ' — crowd long, fade it' : f.accounts < 0.85 ? ' — crowd short, squeeze fuel' : ''}`);
    add('funding', 'Funding rate', f.funding > 0.0003 ? -1 : f.funding < -0.0001 ? 1 : 0,
      `${(f.funding * 100).toFixed(4)}% per 8h${f.funding > 0.0003 ? ' — longs paying a lot' : f.funding < -0.0001 ? ' — shorts paying' : ' — normal'}`);
    const oiLean = f.oiChg > 0.01 ? Math.sign(f.priceChg) : 0;
    add('oi', 'Open interest (4h)', oiLean,
      `OI ${pct(f.oiChg)} with price ${pct(f.priceChg)}${oiLean > 0 ? ' — new longs' : oiLean < 0 ? ' — new shorts' : ''}`);
    if (f.longLiq + f.shortLiq > 0)
      add('liq', 'Liquidations (4h)', 0, `$${k(f.longLiq)} longs vs $${k(f.shortLiq)} shorts wiped`);
  }

  // calendar: never a lean, only a warning
  const soon = (ctx.cal || []).filter(e => (m.news || []).includes(e.country))
    .map(e => ({ ...e, ms: new Date(e.date) - Date.now() })).filter(e => e.ms > -30 * 60e3 && e.ms < 4 * 3600e3)
    .sort((a, b) => a.ms - b.ms)[0];
  add('news', 'News (next 4h)', 0, soon
    ? `${soon.impact === 'High' ? '🔴' : '🟠'} ${soon.country} ${soon.title} ${soon.ms > 0 ? 'in ' + Math.round(soon.ms / 60e3) + ' min' : 'just out'}`
    : 'Nothing medium/high on the calendar', { warn: !!soon && soon.impact === 'High' && Math.abs(soon.ms) < 60 * 60e3 });
  return out;
}

export function verdict(side, checks) {
  const agree = checks.filter(c => c.lean === side).length;
  const oppose = checks.filter(c => c.lean === -side).length;
  const warn = checks.some(c => c.warn);
  const call = warn ? 'WAIT FOR NEWS' : agree >= oppose + 2 ? 'TAKE' : agree > oppose ? 'HALF SIZE' : 'SKIP';
  return { agree, oppose, call };
}

// ─── outcome tracking ───
// Walks the bars since entry. Besides TP / SL it records what the trade went
// through — best excursion (mfe, in R), bars to exit, and whether moving the
// stop to breakeven at +1R would have changed the result — which is what the
// lessons are learned from. If a breakeven lesson was active when the call
// opened (call.mgmt.be), the stop really does move to entry at +1R.
function settle(call, m5) {
  const risk = Math.abs(call.entry - call.sl), d = call.side;
  const after = m5.filter(b => b.t > call.barT);
  let mfe = 0, mae = 0, at1R = false, beTouch = false, bars = 0;
  const out = (status, r, t) => ({ status, r: Math.round(r * 100) / 100, closedAt: t, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), bars, beTouch });
  for (const b of after) {
    bars++;
    const best = ((d > 0 ? b.h : b.l) - call.entry) * d / risk, worst = ((d > 0 ? b.l : b.h) - call.entry) * d / risk;
    const stop = call.mgmt?.be && at1R ? call.entry : call.sl;
    const hitSl = d > 0 ? b.l <= stop : b.h >= stop;
    const hitTp = d > 0 ? b.h >= call.tp : b.l <= call.tp;
    if (at1R && worst <= 0) beTouch = true;
    mae = Math.min(mae, Math.max(worst, -1));
    if (hitSl) { mfe = Math.max(mfe, Math.min(best, RR)); return out(stop === call.entry ? 'be' : 'sl', stop === call.entry ? 0 : -1, b.t * 1000); }
    mfe = Math.max(mfe, Math.min(best, RR));
    if (hitTp) return out('tp', RR, b.t * 1000);
    if (mfe >= 1) at1R = true;
  }
  call.mfe = +mfe.toFixed(2);                                    // live excursion for open calls
  if (Date.now() - call.openedAt > EXPIRE_MS && after.length)
    return out('expired', (after.at(-1).c - call.entry) * d / risk, Date.now());
  return null;
}

// ─── learning from losses ───
// Every closed call goes into a permanent ledger with what it looked like at
// entry. A condition becomes a lesson only with evidence: at least 8 calls,
// a losing average after shrinking toward zero (sum R / (n + 5)), and clearly
// worse than calls without it. Active lessons turn matching new calls into
// SKIP and say why; they switch themselves off again if the numbers recover.
const SESS = h => h < 7 ? 'Asia' : h < 12 ? 'London' : h < 17 ? 'New York' : 'Late US';
function features(m, z, checks, v) {
  const f = {
    market: m.id, class: m.cls, side: z.side > 0 ? 'buy' : 'sell',
    session: SESS(new Date().getUTCHours()),
    volatility: z.volRatio < 0.9 ? 'quiet' : z.volRatio > 1.6 ? 'wild' : 'normal',
    stop: Math.abs(z.entry - z.sl) / z.atr > 1.6 ? 'wide' : 'tight',
    verdict: v.call
  };
  for (const c of checks) if (c.key !== 'news' && c.key !== 'liq') f[c.key] = c.lean === z.side ? 'agrees' : c.lean === -z.side ? 'opposes' : 'neutral';
  if (checks.some(c => c.warn)) f.news = 'high-impact soon';
  return f;
}
const LABEL = { market: 'Market', class: 'Class', side: 'Direction', session: 'Session', volatility: 'Volatility', stop: 'Stop size', verdict: 'Sentiment verdict',
  funds: 'Big funds (COT)', crowd: 'Crowd', etf: 'Gold ETF money', dollar: 'US dollar', yields: 'US yields', taker: 'Taker flow', funding: 'Funding', oi: 'Open interest', news: 'News' };
const describe = (k, val) => ['funds', 'crowd', 'etf', 'dollar', 'yields', 'taker', 'funding', 'oi'].includes(k) ? `${LABEL[k]} ${val}` : `${LABEL[k] || k}: ${val}`;

function learn(ledger) {
  const closed = ledger.filter(t => t.feat);
  const lessons = [];
  const sum = a => a.reduce((s, t) => s + t.r, 0);
  const groups = {};
  for (const t of closed) for (const [k, val] of Object.entries(t.feat)) (groups[`${k}=${val}`] ??= { k, val, list: [] }).list.push(t);
  for (const { k, val, list } of Object.values(groups)) {
    const n = list.length;
    if (n < (k === 'market' ? 6 : 8)) continue;
    const rest = closed.filter(t => t.feat[k] !== val);
    const avg = sum(list) / n, shrunk = sum(list) / (n + 5), restAvg = rest.length ? sum(rest) / rest.length : 0;
    const wins = list.filter(t => t.r > 0).length;
    const active = shrunk < -0.2 && avg < restAvg - 0.3;
    if (active || (n >= 8 && avg < 0))
      lessons.push({ id: `${k}=${val}`, kind: 'filter', key: k, val, active, n, wins, net: +sum(list).toFixed(1), avg: +avg.toFixed(2), restAvg: +restAvg.toFixed(2),
        text: `${describe(k, val)} → ${wins}/${n} won, ${sum(list) >= 0 ? '+' : ''}${sum(list).toFixed(1)}R` + (active ? ' — calls like this are now marked SKIP' : ' — watching, not enough proof yet') });
  }
  // management: would breakeven at +1R have paid across ALL closed calls?
  const beNet = closed.filter(t => t.mfe != null).reduce((s, t) => s + (t.status === 'be' || t.beTouch ? 0 : t.r), 0);
  const realNet = sum(closed.filter(t => t.mfe != null));
  const nm = closed.filter(t => t.mfe != null).length;
  if (nm >= 10) {
    const gain = beNet - realNet, active = gain >= 2 && gain / nm >= 0.15;
    lessons.push({ id: 'manage=be', kind: 'manage', active, n: nm, net: +realNet.toFixed(1), alt: +beNet.toFixed(1),
      text: `Stop to breakeven at +1R: ${realNet.toFixed(1)}R as traded vs ${beNet.toFixed(1)}R with it` + (active ? ' — now applied to new calls' : ' — not worth it yet') });
  }
  // what the losses have in common
  const losses = closed.filter(t => t.r < 0 && t.mfe != null);
  const post = losses.length ? {
    n: losses.length,
    straight: losses.filter(t => t.mfe < 0.3).length,                        // never really went our way
    gaveBack: losses.filter(t => t.mfe >= 1).length,                         // was +1R, came all the way back
    fast: losses.filter(t => t.bars <= 3).length                             // stopped within 15 min
  } : null;
  return { lessons: lessons.sort((a, b) => b.active - a.active || a.avg - b.avg), post, trained: closed.length };
}
function lessonsFor(feat, learned) {
  return (learned?.lessons || []).filter(l => l.active && l.kind === 'filter' && feat[l.key] === l.val);
}
function lossWhy(t) {
  const why = [];
  if (t.mfe != null) {
    if (t.mfe >= 1) why.push(`was +${t.mfe}R before reversing`);
    else if (t.mfe < 0.3) why.push('went straight to the stop');
    if (t.bars <= 3) why.push(`stopped in ${t.bars * 5} min`);
  }
  const f = t.feat || {};
  const against = Object.entries(f).filter(([, v]) => v === 'opposes').map(([k]) => LABEL[k]);
  if (against.length) why.push(`against: ${against.join(', ')}`);
  if (f.news) why.push('news was due');
  if (f.volatility && f.volatility !== 'normal') why.push(`${f.volatility} market`);
  return why;
}

// gold, forex and the 50 most-traded coins ping Telegram; the rest stay on the page
let topCoins = new Set();
const alertable = m => m.cls !== 'crypto' || topCoins.has(m.id);

// Telegram + the ntfy phone app (same topic the MT5 A+ watcher used)
async function telegram(text) {
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    const plain = text.replace(/<[^>]+>/g, ''), [title, ...rest] = plain.split('\n');
    const link = (plain.match(/https:\/\/www\.tradingview\.com\S+/) || [])[0];
    fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST', body: rest.filter(l => !l.startsWith('https://')).join('\n') || title,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, '').trim() || 'F1 call', Priority: /🎯/.test(title) ? 'high' : 'default',
                 Tags: /🎯/.test(title) ? 'dart' : /✅/.test(title) ? 'white_check_mark' : 'x', ...(link ? { Click: link } : {}) }
    }).catch(() => {});
  }
  const t = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!t || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch { /* the page still has it */ }
}

// ─── run ───
async function main() {
  const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return { calls: [] }; } })();
  const calls = prev.calls || [];
  const ledger = prev.ledger || [];
  const learned = learn(ledger);
  const errors = [];
  const soft = (name, p) => p.catch(e => { errors.push(`${name}: ${e.message}`); return null; });

  const [coins, cotData, gld, dxy, bnd, cal] = await Promise.all([
    soft('crypto list', cryptoUniverse()),
    soft('cot', cot(MARKETS.filter(m => m.cot).map(m => m.cot))),
    soft('gld', gldFlow()), soft('dollar', dollar()), soft('bonds', bonds()), soft('calendar', calendar())
  ]);
  const all = [...MARKETS, ...(coins || [])];
  topCoins = new Set((coins || []).slice().sort((a, b) => b.turnover - a.turnover).slice(0, 50).map(c => c.id));
  const ctx = { cot: cotData, gld, dxy, bonds: bnd, cal, flow: {} };

  // pass 1: candles + the A+ zone for everything
  let dropped = 0;
  const scanned = (await pool(all, 8, async m => {
    try {
      const bars = await barsFor(m);
      if (bars.m5.length < 260 || bars.h1.length < 60) return null;
      const newsNear = (cal || []).find(e => (m.news || []).includes(e.country) && Math.abs(new Date(e.date) - Date.now()) < 20 * 60e3);
      return { m, bars, z: aplus(m, bars, newsNear) };
    } catch (e) {
      if (m.cls !== 'crypto' || m.major) errors.push(`${m.id} bars: ${e.message}`);
      else dropped++;
      return null;
    }
  })).filter(Boolean);

  // pass 2: positioning only where it matters — majors, lined-up coins, open calls
  if (dropped > 20) errors.push(`${dropped} coins had no candles this scan`);
  const wanted = scanned.filter(({ m, z }) => m.cls === 'crypto' &&
    (m.major || z.status !== 'none' || calls.some(c => c.market === m.id && c.status === 'active')));
  await pool(wanted, 6, async ({ m }) => { ctx.flow[m.id] = await cryptoFlow(m.contract).catch(() => null); });

  const markets = [];
  for (const { m, bars, z } of scanned) {
    const deep = m.cls !== 'crypto' || !!ctx.flow[m.id];
    const checks = deep ? checksFor(m, ctx) : [];
    const leanSum = checks.reduce((s, c) => s + c.lean, 0);

    // settle open calls on this market
    for (const c of calls.filter(c => c.market === m.id && c.status === 'active')) {
      const done = settle(c, bars.m5);
      if (done) {
        Object.assign(c, done);
        if (c.r < 0) c.why = lossWhy(c);
        ledger.push({ id: c.id, market: c.market, cls: c.cls, side: c.side, feat: c.feat, r: c.r, status: c.status,
          mfe: c.mfe, mae: c.mae, bars: c.bars, beTouch: c.beTouch, openedAt: c.openedAt, closedAt: c.closedAt, why: c.why });
        if (alertable(m)) await telegram(`${done.status === 'tp' ? '✅' : done.status === 'sl' ? '❌' : '⏱'} <b>${m.name || m.id} ${c.side > 0 ? 'BUY' : 'SELL'}</b> closed: ${done.status.toUpperCase()} (${done.r > 0 ? '+' : ''}${done.r}R)`);
      }
    }

    // new call
    if (z.status === 'ready' && !calls.some(c => c.market === m.id && c.status === 'active') &&
        !calls.some(c => c.market === m.id && c.barT === z.barT)) {
      const v = verdict(z.side, checks);
      const feat = features(m, z, checks, v);
      const hits = lessonsFor(feat, learned);
      if (hits.length) v.call = 'SKIP';
      const be = learned.lessons.some(l => l.id === 'manage=be' && l.active);
      const call = {
        feat, lessons: hits.map(l => l.text), mgmt: { be },
        id: `${m.id}-${z.barT}`, market: m.id, name: m.name || m.id, cls: m.cls, dp: m.dp, tv: m.tv, side: z.side, grade: 'A+',
        entry: z.entry, sl: z.sl, tp: z.tp, rr: RR, zone: z.zone, barT: z.barT, openedAt: Date.now(),
        status: 'active', checks, verdict: v
      };
      calls.push(call);
      const f = x => x.toFixed(m.dp);
      if (alertable(m))
        await telegram(`🎯 <b>${call.name} ${z.side > 0 ? 'BUY' : 'SELL'} A+</b>\nEntry ${f(z.entry)}  SL ${f(z.sl)}  TP ${f(z.tp)} (1:${RR})\n` +
          `Sentiment: ${v.agree} agree / ${v.oppose} oppose → <b>${v.call}</b>\n` +
          (hits.length ? `📚 Lesson: ${hits.map(l => l.text).join('; ')}\n` : '') + (be ? 'Move stop to entry at +1R (lesson)\n' : '') +
          checks.filter(c => c.lean).map(c => `${c.lean === z.side ? '✅' : '⚠️'} ${c.label}`).join('\n') +
          `\nhttps://www.tradingview.com/chart/?symbol=${encodeURIComponent(m.tv)}&interval=5`);
    }

    const live = calls.find(c => c.market === m.id && c.status === 'active');
    if (live) live.price = z.price;
    const sig = x => +x.toPrecision(6);
    // volatility: [range %, change %] over the last 5m bar, 1 h and 24 h
    const win = n => {
      const w = bars.m5.slice(-n);
      if (!w.length) return null;
      const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
      return [+((hi - lo) / lo * 100).toFixed(2), +((w.at(-1).c / w[0].o - 1) * 100).toFixed(2)];
    };
    const vol = { m5: win(1), h1: win(12), d1: win(288) };
    markets.push({
      id: m.id, name: m.name || m.id, cls: m.cls, dp: m.dp, tv: m.tv, price: z.price, major: !!m.major,
      turnover: m.turnover ? Math.round(m.turnover) : undefined,
      chg24: bars.h1.length > 24 ? +(z.price / bars.h1.at(-25).c - 1).toFixed(5) : 0,
      spark: bars.h1.slice(-48).filter((_, j, a) => deep || j % 2 === 0 || j === a.length - 1).map(b => sig(b.c)),
      trend: z.trend, status: z.status, side: z.side, zone: z.zone && z.zone.map(sig), blockers: z.blockers || [],
      open: z.fresh, checks, deep, vol, lean: Math.sign(leanSum), leanScore: leanSum
    });
  }

  // keep 30 days of history
  const keep = calls.filter(c => c.status === 'active' || Date.now() - (c.closedAt || c.openedAt) < 30 * 864e5);
  const doc = { updatedAt: Date.now(), rr: RR, markets, calls: keep, errors, cotDate: Object.values(cotData || {})[0]?.date || null,
    ledger: ledger.slice(-3000), learned: learn(ledger) };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc));
  console.log(`calls: ${markets.length}/${all.length} markets, ${Object.values(ctx.flow).filter(Boolean).length} with crypto positioning, ${keep.filter(c => c.status === 'active').length} active, ${keep.length} kept` +
    (errors.length ? `\n  errors: ${errors.join(' | ')}` : ''));
  for (const mk of markets.filter(x => x.cls !== 'crypto' || x.major || x.status === 'ready' || x.status === 'watching'))
    console.log(`  ${mk.id.padEnd(8)} ${String(mk.price).padEnd(10)} ${mk.status.padEnd(9)} H1 ${mk.trend.h1} M15 ${mk.trend.m15} M5 ${mk.trend.m5}  lean ${mk.leanScore}  ${mk.blockers[0] || ''}`);
}

export { learn, lossWhy, aplus, rollup, mexcGet, dukaBars, cryptoUniverse, MARKETS as FIXED, ema, atrAt, trend };
if (process.argv[1]?.endsWith('calls.js')) main().catch(e => { console.error('calls failed:', e); process.exit(1); });
