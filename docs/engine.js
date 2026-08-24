// The server, running in the tab.
//
// public/app.js talks to an Express API and a websocket. GitHub Pages has no
// server, but your phone isn't in a Binance-restricted region — so the same
// modules the server uses (feed.js, strategy.js, volatility.js, screener.js)
// run here instead, against Binance directly. app.js is the same file the live
// server serves — the build only rewrites absolute paths, because Pages serves
// from a subdirectory — so the UI never learns the difference.
//
// What a server would still be needed for:
//   - Telegram / web push. Those need secrets, so the scheduled scanner in
//     .github/workflows/scan.yml keeps doing them, laptop or no laptop.
//   - Scanning while this page is closed. Same answer: the scanner.

import { Feed } from './src/feed.js';
import { analyze, DEFAULTS } from './src/strategy.js';
import { searchSymbols, listSymbols, fetchCandlesDeep } from './src/providers.js';
import { VolatilityScanner } from './src/volatility.js';
import { Screener } from './src/screener.js';
import { hydrate as hydrateLeverage, setOverrides } from './src/leverage.js';
import { buildMessage } from './src/notify.js';
import { filterTrades, aggregate, coverage } from './src/history.js';

// ─── persistence: localStorage instead of data/state.json ───
const KEY = 'f1cloudstate';
const EMPTY = { watches: [], settings: {}, log: [] };

function load() {
  try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return structuredClone(EMPTY); }
}

const state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ } };

// ─── the same engine the server runs ───
const feed = new Feed(() => state.settings.cfg || {});
const vol = new VolatilityScanner();
const screener = new Screener(vol, () => state.settings.cfg || {});

setOverrides(state.settings.levOverride || {});

// MEXC serves no CORS headers, so the page can't read the contract list itself.
// The scheduled scanner publishes it to the state branch instead.
const LEVERAGE_URL = 'https://raw.githubusercontent.com/syedfaisalilyas/f1-signal-alarm/state/leverage.json';
loadLeverage();
async function loadLeverage() {
  // raw.githubusercontent negative-caches a 404 for ~5 minutes, which outlives
  // the gap before the first scan publishes this. A changing query key sidesteps
  // that cache; it moves hourly, and the data only shifts on new listings.
  const bust = Math.floor(Date.now() / 3600000);
  try {
    const r = await fetch(`${LEVERAGE_URL}?v=${bust}`, { cache: 'no-store' });
    if (!r.ok) return console.warn('[engine] no leverage data yet (HTTP ' + r.status + ') — cards show no max leverage');
    console.log('[engine] leverage hydrated for', hydrateLeverage(await r.json()), 'contracts');
  } catch (e) {
    console.warn('[engine] leverage fetch failed:', e.message);
  }
}

// ─── the app's websocket, fulfilled locally ───
const sockets = new Set();

function broadcast(type, payload) {
  const frame = { data: JSON.stringify({ type, payload }) };
  for (const s of sockets) s.onmessage?.(frame);
}

class AppSocket {
  constructor() {
    this.readyState = 1;
    sockets.add(this);
    // Let app.js attach its handlers before anything arrives.
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({
          type: 'init',
          payload: {
            watches: feed.snapshot(),
            settings: state.settings,
            log: state.log.slice(0, 60),
            channels: { telegram: false, ntfy: false, webpush: false },
            vapidPublic: null,
            defaults: DEFAULTS,
            forexEnabled: false        // forex needs a Twelve Data key, i.e. a server
          }
        })
      });
    });
  }
  send() { /* app.js never sends */ }
  close() { sockets.delete(this); this.readyState = 3; }
}

const NativeWS = globalThis.__nativeWS || globalThis.WebSocket;
globalThis.WebSocket = function (url, protocols) {
  // Only the app's own socket is faked; feed.js still opens real ones to Binance.
  return String(url).includes('/ws') && new URL(url, location.href).host === location.host
    ? new AppSocket()
    : new NativeWS(url, protocols);
};
globalThis.WebSocket.prototype = NativeWS.prototype;

// ─── feed events, wired exactly as server.js wires them ───
feed.on('update', (id, a) => broadcast('tick', { id, analysis: slim(a) }));
feed.on('error', (id, error) => broadcast('werror', { id, error }));
feed.on('trend', () => broadcast('watches', feed.snapshot()));

feed.on('signal', (kind, watch, a) => {
  const s = state.settings;
  if (s.muted) return;
  if (kind === 'PREALERT' && s.preAlerts === false) return;
  if (kind === 'EXIT' && s.exitAlerts === false) return;

  const msg = buildMessage(kind, watch, a);
  const entry = {
    kind, id: watch.id, symbol: watch.symbol, interval: watch.interval, market: watch.market,
    title: msg.title, body: msg.body, priority: msg.priority,
    side: a.position?.side || a.forecast?.side || a.justClosed?.side || null,
    detail: kind === 'ENTRY' ? a.position : kind === 'EXIT' ? a.justClosed : a.forecast,
    at: Date.now()
  };
  state.log.unshift(entry);
  if (state.log.length > 300) state.log.length = 300;
  save();
  broadcast('alert', entry);
});

function slim(a) {
  return {
    price: a.price, rsi: a.rsi, atrPct: a.atrPct, volRatio: a.volRatio,
    macdHist: a.macdHist, position: a.position, forecast: a.forecast, profile: a.profile,
    calibration: a.calibration, regime: a.regime, stats: a.stats,
    recent: a.trades.slice(-10).reverse(), lastClosedTime: a.lastClosedTime
  };
}

// ─── the REST API, fulfilled locally ───
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function history(id, params) {
  const w = state.watches.find(x => x.id === id);
  if (!w) return json({ error: 'not watching that symbol' }, 404);

  const limit = Math.min(200, Math.max(5, Number(params.get('limit')) || 20));
  const minVol1h = Number(params.get('minVol1h')) || 0;
  const side = params.get('side') === 'LONG' || params.get('side') === 'SHORT' ? params.get('side') : null;
  const from = Number(params.get('from')) || 0;
  const to = Number(params.get('to')) || 0;
  const bars = limit <= 20 ? 1500 : limit <= 50 ? 3000 : 6000;

  const candles = await fetchCandlesDeep(w.market, w.symbol, w.interval, bars);
  const a = analyze(candles, { ...(state.settings.cfg || {}), ...(w.cfg || {}) });
  const all = [...(a ? a.trades : [])].reverse();
  const filtered = filterTrades(all, { side, from, to, minVol1h });
  const rows = filtered.slice(0, limit);

  return json({
    symbol: w.symbol, interval: w.interval, market: w.market,
    barsScanned: candles.length, totalTrades: all.length, matched: filtered.length,
    covers: coverage(all), stats: aggregate(rows), rows
  });
}

async function volatility(params) {
  const market = params.get('market') === 'spot' ? 'spot' : 'futures';
  const pinned = [...new Set(state.watches.filter(w => w.market === market).map(w => w.symbol))];
  const rows = await vol.board(market, pinned);
  const limit = Math.min(100, Math.max(5, Number(params.get('limit')) || 20));
  const top = rows.slice(0, limit);
  for (const r of rows) if (r.pinned && !top.includes(r)) top.push(r);
  return json({ market, at: Date.now(), rows: top });
}

// Resolve loosely — "trump" or "trumpt" should still land on TRUMPUSDT.
async function lookup(params) {
  const market = params.get('market') === 'spot' ? 'spot' : 'futures';
  const q = (params.get('symbol') || '').trim();
  if (!q) return json({ error: 'symbol required' }, 400);

  const tries = [q.toUpperCase()];
  if (!/USDT$|USDC$|\//i.test(q)) tries.push(q.toUpperCase() + 'USDT');
  for (const sym of tries) {
    try { return json({ ...(await vol.lookup(market, sym)), resolvedFrom: q }); } catch { /* next */ }
  }
  const hits = await searchSymbols(q, [market]);
  let best = hits.find(h => h.quote === 'USDT') || hits[0];
  if (!best) {
    const term = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const all = await listSymbols(market).catch(() => []);
    const cands = all.filter(x => x.quote === 'USDT' && x.base?.length >= 2 && term.startsWith(x.base));
    cands.sort((a, b) => b.base.length - a.base.length);
    best = cands[0];
  }
  if (!best) return json({ error: `no ${market} symbol matching "${q}"` }, 404);
  return json({ ...(await vol.lookup(market, best.symbol)), resolvedFrom: q, fuzzy: true });
}

async function route(path, params, method, body) {
  if (path === '/api/search') return json(await searchSymbols(params.get('q'), ['spot', 'futures']));

  if (path === '/api/watches' && method === 'GET') return json(feed.snapshot());

  if (path === '/api/watches' && method === 'POST') {
    const { market, symbol, interval } = body || {};
    if (!market || !symbol || !interval) return json({ error: 'market, symbol, interval required' }, 400);
    const id = `${market}:${symbol.toUpperCase()}:${interval}`;
    if (state.watches.some(w => w.id === id)) return json({ error: 'already watching that symbol + timeframe' }, 409);
    const w = { id, market, symbol: symbol.toUpperCase(), interval, enabled: true, cfg: {}, addedAt: Date.now() };
    state.watches.push(w);
    save();
    await feed.add(w);
    broadcast('watches', feed.snapshot());
    return json(w);
  }

  if (path.startsWith('/api/watches/')) {
    const id = decodeURIComponent(path.slice('/api/watches/'.length));
    if (method === 'DELETE') {
      feed.remove(id);
      const i = state.watches.findIndex(w => w.id === id);
      if (i >= 0) state.watches.splice(i, 1);
      save();
      broadcast('watches', feed.snapshot());
      return json({ ok: i >= 0 });
    }
    if (method === 'PATCH') {
      const w = state.watches.find(x => x.id === id);
      if (!w) return json({ error: 'not found' }, 404);
      Object.assign(w, body || {});
      save();
      if (body?.cfg) feed.reconfigure(id, w.cfg);
      broadcast('watches', feed.snapshot());
      return json(w);
    }
  }

  if (path === '/api/settings' && method === 'GET') return json(state.settings);
  if (path === '/api/settings' && method === 'POST') {
    Object.assign(state.settings, body || {});
    save();
    if (body && 'levOverride' in body) setOverrides(state.settings.levOverride || {});
    feed.reanalyzeAll();
    broadcast('settings', state.settings);
    return json(state.settings);
  }

  if (path === '/api/log') return json(state.log.slice(0, 100));
  if (path === '/api/volatility') return volatility(params);
  if (path === '/api/volatility/lookup') return lookup(params);
  if (path.startsWith('/api/history/')) return history(decodeURIComponent(path.slice('/api/history/'.length)), params);

  if (path === '/api/screener') {
    const coins = Math.min(30, Math.max(5, Number(params.get('coins')) || 18));
    const d = await screener.run({ market: params.get('market') === 'spot' ? 'spot' : 'futures', coins });
    const watched = new Set(state.watches.map(w => w.id));
    const tag = r => ({ ...r, watched: watched.has(`${r.market}:${r.symbol}:${r.interval}`) });
    return json({
      at: d.at, scanned: d.scanned, qualified: d.qualified, profitable: d.profitable,
      rows: d.rows.slice(0, 40).map(tag), bestPerCoin: d.bestPerCoin.slice(0, 20).map(tag)
    });
  }

  if (path === '/api/push/subscribe') return json({ error: 'web push needs a server — Telegram alerts come from the scheduled scanner' }, 501);

  if (path === '/api/test-alert') {
    broadcast('alert', {
      kind: 'ENTRY', id: 'test', symbol: 'TEST', interval: '3m', market: 'futures',
      title: 'Test alert', body: 'This page is live. Telegram alerts are sent by the scheduled scanner.',
      priority: 4, side: 'LONG', at: Date.now()
    });
    return json({ ok: true, channels: {}, results: { browser: 'shown' } });
  }

  return json({ error: 'not found' }, 404);
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const parsed = new URL(url, location.href);
  if (parsed.host !== location.host || !parsed.pathname.includes('/api/')) {
    return nativeFetch(input, init);
  }
  // Pages serves from /f1-signal-alarm/, so match on the /api/… tail.
  const path = parsed.pathname.slice(parsed.pathname.indexOf('/api/'));
  const method = (init.method || 'GET').toUpperCase();
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { /* not json */ }
  try {
    return await route(path, parsed.searchParams, method, body);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

// ─── boot: restore the watchlist into the feed ───
// server.js starts this too. Without it a silent stream never falls back to
// polling — and Binance's futures stream is silent on plenty of networks: it
// accepts the handshake, acks the subscription, then sends no candles at all.
feed.startWatchdog();
feed.startTrendWatch();

for (const w of state.watches) feed.add(w).catch(() => { /* reported through werror */ });
queueMicrotask(() => broadcast('watches', feed.snapshot()));

console.log(`[engine] running in-page · ${state.watches.length} watch(es) restored`);
