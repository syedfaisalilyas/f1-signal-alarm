import './src/env.js';   // must be first — populates process.env from .env
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import * as store from './src/store.js';
import { Feed } from './src/feed.js';
import { searchSymbols, ticker24h, fetchCandles, fetchCandlesDeep, listSymbols } from './src/providers.js';
import { analyze } from './src/strategy.js';
import { filterTrades, aggregate, coverage } from './src/history.js';
import { initPush, channelStatus, buildMessage, dispatch } from './src/notify.js';
import { DEFAULTS } from './src/strategy.js';
import { VolatilityScanner } from './src/volatility.js';
import { Screener } from './src/screener.js';
import { IgnitionScanner } from './src/ignition.js';
import { coinReport } from './src/coinreport.js';
import { hotSweep, hotMessage, HOT_DEFAULTS } from './src/hotwatch.js';
import { refresh as refreshLeverage, loaded as levLoaded, sourceName as levSourceName, setOverrides } from './src/leverage.js';
import { resolve as resolveInstrument, INSTRUMENTS } from './src/symbols.js';
import { newsFor, calendar as newsCalendar } from './src/news.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '256kb' }));

// ─── access gate (only active when APP_PASSWORD is set) ───
const APP_KEY = process.env.APP_PASSWORD || null;
const cookieOf = (h, n) => (h || '').split(';').map(c => c.trim().split('='))
  .find(([k]) => k === n)?.[1];
function authed(req) {
  if (!APP_KEY) return true;
  const k = req.headers['x-app-key'] || req.query.key || cookieOf(req.headers.cookie, 'appkey');
  return k === APP_KEY;
}
app.use('/api', (req, res, next) =>
  authed(req) ? next() : res.status(401).json({ error: 'unauthorized' }));

app.use(express.static(path.join(__dirname, 'public')));

initPush();
const feed = new Feed(() => store.get().settings.cfg || {});
const vol = new VolatilityScanner();
const screener = new Screener(vol, () => store.get().settings.cfg || {});
const igniter = new IgnitionScanner(fetchCandles, () => store.get().settings.ignition || {}, fetchCandlesDeep);

// ─────────────── browser fan-out ───────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

// Cloudflare drops idle websockets, which showed up in the UI as an endless
// "reconnecting…". A periodic ping keeps them open.
const heartbeat = setInterval(() => {
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (c.isAlive === false) { c.terminate(); continue; }
    c.isAlive = false;
    try { c.ping(); } catch {}
  }
}, 25000);
heartbeat.unref?.();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (APP_KEY) {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    if (key !== APP_KEY) return ws.close(4001, 'unauthorized');
  }
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      watches: feed.snapshot(),
      settings: store.get().settings,
      log: store.get().log.slice(0, 60),
      channels: channelStatus(),
      vapidPublic: process.env.VAPID_PUBLIC || null,
      defaults: DEFAULTS,
      forexEnabled: !!process.env.TWELVEDATA_KEY
    }
  }));
});

feed.on('update', (id, a) => broadcast('tick', { id, analysis: slimForUi(a) }));
feed.on('error', (id, error) => broadcast('werror', { id, error }));
feed.on('status', (market, status) => broadcast('status', { market, status }));
feed.on('trend', () => broadcast('watches', feed.snapshot()));

// Log it, push it to every open tab, deliver it to the phone. Both the
// per-watch signals and the market-wide sweeps end up here.
async function announce(entry, msg) {
  store.pushLog(entry);
  broadcast('alert', entry);
  const res = await dispatch(msg, store.get().pushSubs, ep => store.removeSub(ep));
  console.log(`[${entry.kind}] ${entry.symbol}${entry.interval ? ' ' + entry.interval : ''} →`, res);
  return res;
}

feed.on('signal', async (kind, watch, a) => {
  const s = store.get().settings;
  if (s.muted) return;
  if (kind === 'PREALERT' && s.preAlerts === false) return;
  if (kind === 'EXIT' && s.exitAlerts === false) return;
  if (kind === 'LOWVOL' && s.lowVolAlerts === false) return;

  const msg = buildMessage(kind, watch, a);
  const entry = {
    kind, id: watch.id, symbol: watch.symbol, interval: watch.interval, market: watch.market,
    title: msg.title, body: msg.body, priority: msg.priority,
    side: a.position?.side || a.forecast?.side || a.justClosed?.side || null,
    detail: kind === 'ENTRY' ? a.position : kind === 'EXIT' ? a.justClosed : kind === 'LOWVOL' ? a.vol : a.forecast
  };
  await announce(entry, msg);
});

// ─── hot hours: the market-wide wake-up watch ───
//
// Fires a few minutes after each hourly close, because the trigger is a CLOSED
// hour — reading a forming candle would alarm on the first violent minute and
// take it back twenty minutes later.
//
// One alert per coin per wake-up: the trigger already requires six calm hours
// first, so a coin cannot re-fire while it runs, and the cooldown covers the
// case where it goes quiet and pops again the same afternoon.
const hotSeen = new Map();
const HOT_COOLDOWN = 6 * 60 * 60 * 1000;
let lastHotSweep = null, lastHotHour = null;

function startHotWatch() {
  const tick = async () => {
    const s = store.get().settings;
    const cfg = { ...HOT_DEFAULTS, ...(s.hotHours || {}) };
    if (cfg.enabled === false || s.muted) return;

    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    if (lastHotHour === hour) return;                       // already done this hour
    if (Date.now() - hour < 2 * 60 * 1000) return;          // let the close settle
    lastHotHour = hour;

    let sweep;
    try { sweep = await hotSweep(cfg); }
    catch (e) { return console.error('[hot] sweep failed:', e.message); }
    lastHotSweep = sweep;

    const first = hotSeen.size === 0 && !store.get().log.some(l => l.kind === 'HOTHOURS');
    for (const c of sweep.confirmed) {
      if (c.grade === 'C') continue;
      if ((cfg.alertOn || 'AB') === 'A' && c.grade !== 'A') continue;
      const seen = hotSeen.get(c.symbol);
      if (seen && Date.now() - seen < HOT_COOLDOWN) continue;
      hotSeen.set(c.symbol, Date.now());
      if (first) continue;               // seed on the first sweep, don't blast the board

      const msg = hotMessage(c);
      await announce({
        kind: 'HOTHOURS', id: `${c.market}:${c.symbol}:1h`,
        symbol: c.symbol, interval: '1h', market: c.market,
        title: msg.title, body: msg.body, priority: msg.priority,
        side: c.report?.plan?.side || null,
        detail: { grade: c.grade, why: c.why, ratio: c.ratio, volX: c.volX, plan: c.report?.plan || null },
        at: Date.now()
      }, msg);
    }
    for (const [k, t] of hotSeen) if (Date.now() - t > HOT_COOLDOWN) hotSeen.delete(k);
    console.log(`[hot] ${sweep.scanned} coins, ${sweep.hits.length} woke up, ` +
      `${sweep.confirmed.filter(c => c.grade !== 'C').length} worth an alarm${first ? ' — first sweep, seeded silently' : ''}`);
  };
  setInterval(tick, 60 * 1000).unref();
  setTimeout(tick, 20000);
}

// A watched coin that stops moving can't reach TP — worth knowing before you
// sit through it. Requires two consecutive flat reads so a quiet patch mid-scan
// doesn't trigger it, and resets once the coin wakes up.
const volState = new Map();
function startLowVolWatch() {
  const tick = async () => {
    const s = store.get().settings;
    if (s.lowVolAlerts === false || s.muted) return;
    const threshold = Number(s.lowVol1h) > 0 ? Number(s.lowVol1h) : 1.0;
    const markets = [...new Set(feed.snapshot().map(w => w.market))].filter(m => m !== 'forex');
    for (const market of markets) {
      let rows;
      try { rows = await vol.board(market, feed.snapshot().filter(w => w.market === market).map(w => w.symbol)); }
      catch { continue; }
      const bySym = new Map(rows.map(r => [r.symbol, r]));

      // Volatility belongs to the coin, not the chart interval — one alert per
      // symbol however many timeframes of it are being watched.
      const watched = new Map();
      for (const w of feed.snapshot()) {
        if (w.market !== market) continue;
        if (!watched.has(w.symbol)) watched.set(w.symbol, []);
        watched.get(w.symbol).push(w);
      }

      for (const [symbol, group] of watched) {
        const r = bySym.get(symbol);
        if (!r || r.vol1h === null) continue;
        const key = `${market}:${symbol}`;
        const st = volState.get(key) || { strikes: 0, notifiedAt: 0 };
        if (r.vol1h < threshold) {
          st.strikes++;
          const cooled = Date.now() - st.notifiedAt > 2 * 60 * 60 * 1000;
          if (st.strikes >= 2 && cooled) {
            st.notifiedAt = Date.now();
            const tfs = group.map(g => g.interval).join(', ');
            feed.emit('signal', 'LOWVOL', { ...group[0], interval: tfs }, { vol: { ...r, threshold } });
          }
        } else {
          st.strikes = 0;
        }
        volState.set(key, st);
      }
    }
  };
  setInterval(tick, 2 * 60 * 1000).unref();
  setTimeout(tick, 45000);
}

function slimForUi(a) {
  return {
    price: a.price, rsi: a.rsi, atrPct: a.atrPct, volRatio: a.volRatio,
    macdHist: a.macdHist, position: a.position, forecast: a.forecast, profile: a.profile, calibration: a.calibration, regime: a.regime,
    stats: a.stats, recent: a.trades.slice(-10).reverse(), lastClosedTime: a.lastClosedTime
  };
}

// ─────────────── REST API ───────────────
app.get('/api/search', async (req, res) => {
  try {
    const markets = ['spot', 'futures'];
    if (process.env.TWELVEDATA_KEY) markets.push('forex');
    res.json(await searchSymbols(req.query.q, markets));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The scheduled scanner reads cloud/watchlist.json, not data/state.json, so a
// coin added here had to be synced by hand before Telegram knew about it. Now
// every change writes that file straight away — it still needs committing to
// reach the runner, but it can no longer silently drift out of date.
//
// Both board-wide sweeps are forced off: they alert on whatever the whole
// market is doing, which is exactly what "only the coins I added" rules out.
function writeCloudWatchlist() {
  try {
    const s = store.get();
    const file = path.join(__dirname, 'cloud', 'watchlist.json');
    const next = {
      watches: s.watches,
      settings: {
        ...s.settings,
        ignition: { ...(s.settings.ignition || {}), enabled: false },
        hotHours: { ...(s.settings.hotHours || {}), enabled: false }
      }
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (e) {
    console.warn('[watchlist] could not write cloud/watchlist.json —', e.message);
  }
}

app.get('/api/watches', (_req, res) => res.json(feed.snapshot()));

app.post('/api/watches', async (req, res) => {
  const { market, symbol, interval, cfg } = req.body || {};
  if (!market || !symbol || !interval) return res.status(400).json({ error: 'market, symbol, interval required' });
  const w = store.addWatch({ market, symbol: symbol.toUpperCase(), interval, cfg: {} });
  if (!w) return res.status(409).json({ error: 'already watching that symbol + timeframe' });
  await feed.add(w);
  writeCloudWatchlist();
  broadcast('watches', feed.snapshot());
  res.json(w);
});

app.delete('/api/watches/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  feed.remove(id);
  const ok = store.removeWatch(id);
  writeCloudWatchlist();
  broadcast('watches', feed.snapshot());
  res.json({ ok });
});

app.patch('/api/watches/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const w = store.updateWatch(id, req.body || {});
  if (!w) return res.status(404).json({ error: 'not found' });
  if (req.body.cfg) feed.reconfigure(id, w.cfg);
  writeCloudWatchlist();
  broadcast('watches', feed.snapshot());
  res.json(w);
});

app.get('/api/volatility', async (req, res) => {
  try {
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const pinned = feed.snapshot().filter(w => w.market === market).map(w => w.symbol);
    const rows = await vol.board(market, [...new Set(pinned)]);
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 20));
    const top = rows.slice(0, limit);
    // always surface watched symbols, even when they rank below the cut
    for (const r of rows) if (r.pinned && !top.includes(r)) top.push(r);
    res.json({ market, at: Date.now(), rows: top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/volatility/lookup', async (req, res) => {
  try {
    const market = req.query.market === 'spot' ? 'spot' : 'futures';
    const q = (req.query.symbol || '').trim();
    if (!q) return res.status(400).json({ error: 'symbol required' });

    // "gold" is not a Binance symbol. Named instruments resolve to whichever
    // feed can actually answer for them, which may not be the selected market.
    const inst = resolveInstrument(q);
    if (inst?.unavailable) return res.status(503).json({ error: inst.reason });
    if (inst) {
      const row = await vol.lookup(inst.market, inst.symbol);
      return res.json({ ...row, resolvedFrom: q, instrument: inst.id,
        label: inst.label, proxied: inst.proxied, note: inst.note });
    }

    // Resolve loosely: exact, then +USDT, then the best fuzzy match from the
    // exchange list. Typing "trump" or fat-fingering "trumpt" should still land
    // on TRUMPUSDT rather than returning a raw 400.
    const tries = [q.toUpperCase()];
    if (!/USDT$|USDC$|\//i.test(q)) tries.push(q.toUpperCase() + 'USDT');
    for (const sym of tries) {
      try { return res.json({ ...(await vol.lookup(market, sym)), resolvedFrom: q }); } catch { /* next */ }
    }
    const hits = await searchSymbols(q, [market]);
    let best = hits.find(h => h.quote === 'USDT') || hits[0];

    // Still nothing: the coin name may be a prefix of what was typed
    // ("trumpt" -> TRUMP). Take the longest base asset the query starts with.
    if (!best) {
      const term = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const all = await listSymbols(market).catch(() => []);
      const cands = all.filter(x => x.quote === 'USDT' && x.base && x.base.length >= 2 && term.startsWith(x.base));
      cands.sort((a, b) => b.base.length - a.base.length);
      best = cands[0];
    }
    if (!best) return res.status(404).json({ error: `no ${market} symbol matching "${q}"` });
    res.json({ ...(await vol.lookup(market, best.symbol)), resolvedFrom: q, fuzzy: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deeper trade log than the live window keeps, optionally only the trades
// taken while the coin was actually moving.
const histCache = new Map();
app.get('/api/history/:id', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const w = store.get().watches.find(x => x.id === id);
    if (!w) return res.status(404).json({ error: 'not watching that symbol' });

    const limit = Math.min(200, Math.max(5, Number(req.query.limit) || 20));
    const minVol1h = Number(req.query.minVol1h) || 0;
    const side = req.query.side === 'LONG' || req.query.side === 'SHORT' ? req.query.side : null;
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || 0;
    const bars = limit <= 20 ? 1500 : limit <= 50 ? 3000 : 6000;

    const key = `${id}:${bars}`;
    let cached = histCache.get(key);
    if (!cached || Date.now() - cached.at > 120000) {
      const candles = await fetchCandlesDeep(w.market, w.symbol, w.interval, bars);
      const a = analyze(candles, { ...(store.get().settings.cfg || {}), ...(w.cfg || {}) });
      cached = { at: Date.now(), bars: candles.length, trades: a ? a.trades : [] };
      histCache.set(key, cached);
    }

    const all = [...cached.trades].reverse();
    const filtered = filterTrades(all, { side, from, to, minVol1h });
    const rows = filtered.slice(0, limit);

    res.json({
      symbol: w.symbol, interval: w.interval, market: w.market,
      barsScanned: cached.bars, totalTrades: all.length, matched: filtered.length,
      covers: coverage(all), stats: aggregate(rows), rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/screener', async (req, res) => {
  try {
    const coins = Math.min(30, Math.max(5, Number(req.query.coins) || 18));
    const from = Number(req.query.from) || 0;
    const to = Number(req.query.to) || 0;
    const d = await screener.run({ market: req.query.market === 'spot' ? 'spot' : 'futures', coins, from, to });
    const watched = new Set(feed.snapshot().map(w => `${w.market}:${w.symbol}:${w.interval}`));
    const tag = r => ({ ...r, watched: watched.has(`${r.market}:${r.symbol}:${r.interval}`) });
    res.json({
      at: d.at, from: d.from, to: d.to, reach: d.reach,
      scanned: d.scanned, qualified: d.qualified, profitable: d.profitable,
      rows: d.rows.slice(0, 40).map(tag), bestPerCoin: d.bestPerCoin.slice(0, 20).map(tag)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The whole board, not just the watchlist: which coin just left a dead range,
// and which ones are wound up ready to. Cached — one sweep is ~300 requests.
app.get('/api/ignition', async (req, res) => {
  try {
    const d = await igniter.run({
      market: req.query.market === 'spot' ? 'spot' : 'futures',
      interval: ['1m', '3m', '5m', '15m', '1h'].includes(req.query.interval) ? req.query.interval : '1h',
      minQuoteVol: Math.max(1e5, Number(req.query.minVol) || 3e6)
    });
    const fresh = Math.max(1, Number(req.query.fresh) || 3);
    const watched = new Set(feed.snapshot().map(w => `${w.market}:${w.symbol}`));
    const tag = r => ({ ...r, watched: watched.has(`${r.market}:${r.symbol}`) });
    res.json({
      at: d.at, market: d.market, interval: d.interval,
      scanned: d.scanned, analysed: d.analysed,
      igniting: d.igniting.filter(r => r.fired.barsAgo <= fresh).map(tag),
      stale: d.igniting.filter(r => r.fired.barsAgo > fresh).slice(0, 12).map(tag),
      coiling: d.coiling.slice(0, 20).map(tag),
      history: d.history.slice(0, 25)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the hot-hours watch is looking at right now — the same sweep the alarm
// fires from, so the board and the alarm can never disagree.
app.get('/api/hothours', async (req, res) => {
  try {
    const cfg = { ...HOT_DEFAULTS, ...(store.get().settings.hotHours || {}) };
    // Only sweep on an explicit refresh. The hourly watch fills this in on
    // its own, and opening the board should never cost 200 requests.
    if (req.query.fresh === '1') lastHotSweep = await hotSweep(cfg);
    const d = lastHotSweep;
    if (!d) return res.json({ at: null, market: cfg.market, pending: true, confirmed: [], hits: [] });
    res.json({
      at: d.at, market: d.market, scanned: d.scanned,
      confirmed: d.confirmed.map(c => ({ ...c, report: c.report ? { plan: c.report.plan, volatility: { ...c.report.volatility, profile: undefined }, liquidity: c.report.liquidity } : null })),
      hits: d.hits.slice(0, 30)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One coin, everything: liquidity, volatility in its own units, trend on six
// timeframes, levels, fib, sweeps, order flow — and a side, or a refusal.
app.get('/api/coin', async (req, res) => {
  try {
    const raw = (req.query.symbol || '').trim();
    const inst = resolveInstrument(raw);
    if (inst?.unavailable) return res.status(503).json({ error: inst.reason });

    const market = inst ? inst.market
      : req.query.market === 'spot' ? 'spot'
      : req.query.market === 'forex' ? 'forex' : 'futures';
    const symbol = inst ? inst.symbol : raw.toUpperCase();
    // Binance lists perps named 龙虾USDT and 牛来USDT, so this cannot be an
    // A-Z test — it only has to reject what would break a URL. Forex symbols
    // carry a slash (XAU/USD), which is legal there and nowhere else.
    const bad = market === 'forex' ? /[\s?&#]/ : /[\s/?&#]/;
    if (symbol.length < 3 || symbol.length > 24 || bad.test(symbol))
      return res.status(400).json({ error: 'symbol required' });

    const report = await coinReport(market, symbol);
    if (inst) Object.assign(report, {
      instrument: inst.id, label: inst.label, proxied: inst.proxied, note: inst.note, unit: inst.unit
    });
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deeper than the live sweep reaches — a bounded pass over the most liquid
// names so a year of history never slows down "what is igniting now".
app.get('/api/ignition/history', async (req, res) => {
  try {
    const d = await igniter.history({
      market: req.query.market === 'spot' ? 'spot' : 'futures',
      interval: ['5m', '15m', '1h', '4h'].includes(req.query.interval) ? req.query.interval : '1h',
      days: Math.min(365, Math.max(1, Number(req.query.days) || 30)),
      coins: Math.min(150, Math.max(10, Number(req.query.coins) || 80)),
      minQuoteVol: Math.max(1e5, Number(req.query.minVol) || 3e6)
    });
    res.json({ at: d.at, interval: d.interval, days: d.days, coins: d.coins,
      asked: d.asked, reach: d.reach, rows: d.rows.slice(0, 300) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Calendar, headlines and what past releases actually did to the price.
// Only meaningful for instruments that trade on a schedule — a memecoin has no
// CPI print — so it answers for named instruments and forex, and says so
// plainly for anything else rather than inventing relevance.
app.get('/api/news', async (req, res) => {
  try {
    const raw = (req.query.symbol || '').trim();
    if (!raw) return res.status(400).json({ error: 'symbol required' });
    const inst = resolveInstrument(raw);
    if (inst?.unavailable) return res.status(503).json({ error: inst.reason });

    const market = inst ? inst.market
      : req.query.market === 'spot' ? 'spot'
      : req.query.market === 'forex' ? 'forex' : 'futures';
    const symbol = inst ? inst.symbol : raw.toUpperCase();
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));

    res.json(await newsFor({ market, symbol, instrument: inst?.id, days }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The whole week, unfiltered — for a calendar view rather than one instrument.
app.get('/api/calendar', async (req, res) => {
  try {
    const all = await newsCalendar();
    const from = Number(req.query.from) || Date.now() - 7 * 24 * 3600 * 1000;
    const to = Number(req.query.to) || Date.now() + 14 * 24 * 3600 * 1000;
    const minRank = Math.max(0, Math.min(3, Number(req.query.minRank) ?? 2));
    res.json({ at: Date.now(), rows: all.filter(e => e.at >= from && e.at <= to && e.rank >= minRank) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the search box can offer besides coins.
app.get('/api/instruments', (_req, res) => res.json(
  INSTRUMENTS.map(i => ({ id: i.id, name: i.name, ...(resolveInstrument(i.aliases[0]) || {}) }))
));

app.get('/api/settings', (_req, res) => res.json(store.get().settings));
app.post('/api/settings', (req, res) => {
  Object.assign(store.get().settings, req.body || {});
  store.save();
  if (req.body && 'levOverride' in req.body) setOverrides(store.get().settings.levOverride || {});
  if (req.body && 'cfg' in req.body) feed.reanalyzeAll();
  broadcast('watches', feed.snapshot());
  broadcast('settings', store.get().settings);
  res.json(store.get().settings);
});

app.get('/api/log', (_req, res) => res.json(store.get().log.slice(0, 100)));

app.post('/api/push/subscribe', (req, res) => { store.addSub(req.body); res.json({ ok: true }); });
app.post('/api/push/unsubscribe', (req, res) => { store.removeSub(req.body?.endpoint); res.json({ ok: true }); });

app.post('/api/test-alert', async (_req, res) => {
  const msg = {
    title: '🔔 F1 Alarm test',
    body: 'If you can read this on your phone, alerts are wired up correctly.',
    telegram: '<b>🔔 F1 Alarm test</b>\nIf you can read this on your phone, alerts are wired up correctly.',
    priority: 5, tags: ['bell']
  };
  const out = await dispatch(msg, store.get().pushSubs, ep => store.removeSub(ep));
  res.json({ channels: channelStatus(), result: out });
});

app.get('/api/ticker/:market/:symbol', async (req, res) => {
  try { res.json(await ticker24h(req.params.market, req.params.symbol)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────── boot ───────────────
const PORT = process.env.PORT || 8787;
server.listen(PORT, async () => {
  const ch = channelStatus();
  console.log(`\n  F1 Signal Alarm  →  http://localhost:${PORT}\n`);
  console.log(`  channels: telegram=${ch.telegram ? 'on' : 'off'}  ntfy=${ch.ntfy ? 'on' : 'off'}  webpush=${ch.webpush ? 'on' : 'off'}`);
  console.log(`  forex: ${process.env.TWELVEDATA_KEY ? 'on' : 'off (set TWELVEDATA_KEY)'}`);
  console.log(`  access: ${APP_KEY ? 'password protected' : 'OPEN (set APP_PASSWORD before exposing publicly)'}\n`);
  // Older watches stored a full config snapshot, freezing them on the settings
  // present when they were added. Drop those so live settings apply.
  let migrated = 0;
  for (const w of store.get().watches) {
    if (w.cfg && Object.keys(w.cfg).length > 3) { w.cfg = {}; migrated++; }
  }
  if (migrated) { store.save(); console.log(`  migrated ${migrated} watch(es) to live settings`); }

  setOverrides(store.get().settings.levOverride || {});
  await refreshLeverage();
  console.log(`  leverage: ${levLoaded()} contracts via ${levSourceName()}`);
  setInterval(refreshLeverage, 12 * 60 * 60 * 1000).unref();

  const watches = store.get().watches;
  for (const w of watches) await feed.add(w);
  feed.startWatchdog();
  feed.startTrendWatch();
  startLowVolWatch();
  startHotWatch();

  // Warm the board so the first browser request is served from cache instead of
  // waiting on a full market scan behind the tunnel.
  vol.board('futures', []).then(r => console.log(`  volatility: ${r.length} coins pre-scanned`))
     .catch(e => console.log('  volatility: pre-scan failed —', e.message));
  if (watches.length) console.log(`  restored ${watches.length} watch(es)\n`);
});
