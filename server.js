import './src/env.js';   // must be first — populates process.env from .env
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import * as store from './src/store.js';
import { Feed } from './src/feed.js';
import { searchSymbols, ticker24h } from './src/providers.js';
import { initPush, channelStatus, buildMessage, dispatch } from './src/notify.js';
import { DEFAULTS } from './src/strategy.js';
import { VolatilityScanner } from './src/volatility.js';
import { refresh as refreshLeverage, loaded as levLoaded, sourceName as levSourceName, setOverrides } from './src/leverage.js';

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
  store.pushLog(entry);
  broadcast('alert', entry);

  const res = await dispatch(msg, store.get().pushSubs, ep => store.removeSub(ep));
  console.log(`[${kind}] ${watch.symbol} ${watch.interval} →`, res);
});

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
    macdHist: a.macdHist, position: a.position, forecast: a.forecast, profile: a.profile, calibration: a.calibration,
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

app.get('/api/watches', (_req, res) => res.json(feed.snapshot()));

app.post('/api/watches', async (req, res) => {
  const { market, symbol, interval, cfg } = req.body || {};
  if (!market || !symbol || !interval) return res.status(400).json({ error: 'market, symbol, interval required' });
  const w = store.addWatch({ market, symbol: symbol.toUpperCase(), interval, cfg: {} });
  if (!w) return res.status(409).json({ error: 'already watching that symbol + timeframe' });
  await feed.add(w);
  broadcast('watches', feed.snapshot());
  res.json(w);
});

app.delete('/api/watches/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  feed.remove(id);
  const ok = store.removeWatch(id);
  broadcast('watches', feed.snapshot());
  res.json({ ok });
});

app.patch('/api/watches/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const w = store.updateWatch(id, req.body || {});
  if (!w) return res.status(404).json({ error: 'not found' });
  if (req.body.cfg) feed.reconfigure(id, w.cfg);
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
    if (!req.query.symbol) return res.status(400).json({ error: 'symbol required' });
    res.json(await vol.lookup(market, req.query.symbol));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  console.log(`  leverage: ${levLoaded()} symbols via ${levSourceName()}`);
  setInterval(refreshLeverage, 12 * 60 * 60 * 1000).unref();

  const watches = store.get().watches;
  for (const w of watches) await feed.add(w);
  feed.startWatchdog();
  startLowVolWatch();

  // Warm the board so the first browser request is served from cache instead of
  // waiting on a full market scan behind the tunnel.
  vol.board('futures', []).then(r => console.log(`  volatility: ${r.length} coins pre-scanned`))
     .catch(e => console.log('  volatility: pre-scan failed —', e.message));
  if (watches.length) console.log(`  restored ${watches.length} watch(es)\n`);
});
