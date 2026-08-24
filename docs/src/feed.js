// Live candle feed + signal detection loop.
// Binance streams over WebSocket; forex polls (no free WS provider).

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WS_URL, fetchCandles } from './providers.js';
import { analyze } from './strategy.js';
import { intervalMin } from './notify.js';
import { maxLev } from './leverage.js';

const MAX_BARS = 600;
const ANALYZE_THROTTLE = 1500;
const PREALERT_COOLDOWN = 10 * 60 * 1000;

export class Feed extends EventEmitter {
  // getGlobalCfg supplies the live settings. Watches keep only their own
  // explicit overrides, so changing a setting reaches every existing symbol
  // instead of only ones added afterwards.
  constructor(getGlobalCfg = () => ({})) {
    super();
    this.getGlobalCfg = getGlobalCfg;
    this.watches = new Map();     // id -> { watch, candles, last, marks }
    this.sockets = {};            // market -> ws
    this.pending = {};            // market -> desired stream set
    this.reconnectDelay = {};
  }

  streamName(w) { return `${w.symbol.toLowerCase()}@kline_${w.interval}`; }

  // Some networks accept a websocket handshake to Binance and then never
  // deliver frames (fstream is commonly blocked this way). The socket looks
  // healthy, so watch actual data instead and fall back to REST polling.
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const e of this.watches.values()) {
        if (e.watch.market === 'forex' || e.loading) continue;
        // Binance pushes kline updates every second or two on any active symbol,
        // whatever the timeframe — so this is a liveness timeout, not a candle
        // duration. Capped so a 5m watch doesn't sit frozen for six minutes.
        const limit = Math.min(120000, Math.max(75000, intervalMin(e.watch.interval) * 60000 * 1.2));
        const silent = now - (e.lastTickAt || 0) > limit;
        if (silent && !e.pollTimer) {
          e.streamDead = true;
          this.startPoll(e);
          this.emit('status', e.watch.market, 'stream silent — polling');
          console.log(`[feed] ${e.watch.id}: no stream data in ${Math.round(limit / 1000)}s, falling back to REST polling`);
        } else if (!silent && e.streamDead && e.pollTimer) {
          clearInterval(e.pollTimer);
          e.pollTimer = null;
          e.streamDead = false;
          console.log(`[feed] ${e.watch.id}: stream recovered, polling stopped`);
        }
      }
    }, 20000);
    this.watchdog.unref?.();
  }

  async add(watch) {
    if (this.watches.has(watch.id)) return this.watches.get(watch.id);
    const entry = { watch, candles: [], last: null, marks: {}, error: null, loading: true };
    this.watches.set(watch.id, entry);
    try {
      entry.candles = await fetchCandles(watch.market, watch.symbol, watch.interval, MAX_BARS);
      entry.loading = false;
      // Seed marks from history so we don't fire alerts for signals that already happened
      const a = analyze(entry.candles, { ...this.getGlobalCfg(), ...(watch.cfg || {}) });
      if (a) {
        entry.last = a;
        entry.marks.entryTime = a.position ? a.position.entryTime : null;
        entry.marks.exitTime = a.trades.length ? a.trades[a.trades.length - 1].exitTime : null;
        this.emit('update', watch.id, a);
      }
    } catch (e) {
      entry.error = e.message;
      entry.loading = false;
      this.emit('error', watch.id, e.message);
    }
    entry.lastTickAt = Date.now();
    if (watch.market === 'forex') this.startPoll(entry);
    else this.syncSockets();
    return entry;
  }

  remove(id) {
    const e = this.watches.get(id);
    if (e?.pollTimer) clearInterval(e.pollTimer);
    this.watches.delete(id);
    this.syncSockets();
  }

  reconfigure(id, cfg) {
    const e = this.watches.get(id);
    if (!e) return;
    e.watch.cfg = cfg;
    this.run(e, true);
  }

  // Re-analyse everything after a settings change.
  reanalyzeAll() {
    for (const e of this.watches.values()) this.run(e, true);
  }

  // ── Binance WebSocket wiring ──
  syncSockets() {
    for (const market of ['spot', 'futures']) {
      const streams = [...this.watches.values()]
        .filter(e => e.watch.market === market && e.watch.enabled !== false)
        .map(e => this.streamName(e.watch));
      const want = [...new Set(streams)];
      this.pending[market] = want;
      if (!want.length) { this.sockets[market]?.close(); this.sockets[market] = null; continue; }
      const ws = this.sockets[market];
      if (!ws || ws.readyState > 1) this.connect(market);
      else if (ws.readyState === 1) this.applySubs(market);
    }
  }

  connect(market) {
    const ws = new WebSocket(WS_URL[market]);
    this.sockets[market] = ws;
    ws.on('open', () => {
      this.reconnectDelay[market] = 1000;
      this.emit('status', market, 'connected');
      ws.subscribed = [];
      this.applySubs(market);
    });
    ws.on('message', buf => {
      try {
        const msg = JSON.parse(buf);
        if (msg.data?.e === 'kline') this.onKline(market, msg.data);
      } catch { /* ignore malformed frames */ }
    });
    ws.on('close', () => {
      this.emit('status', market, 'disconnected');
      if (!this.pending[market]?.length) return;
      const d = Math.min((this.reconnectDelay[market] || 1000) * 2, 30000);
      this.reconnectDelay[market] = d;
      setTimeout(() => { if (this.pending[market]?.length) this.connect(market); }, d);
    });
    ws.on('error', () => ws.close());
  }

  applySubs(market) {
    const ws = this.sockets[market];
    if (!ws || ws.readyState !== 1) return;
    const want = this.pending[market] || [];
    const have = ws.subscribed || [];
    const add = want.filter(s => !have.includes(s));
    const drop = have.filter(s => !want.includes(s));
    if (add.length) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: add, id: Date.now() }));
    if (drop.length) ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: drop, id: Date.now() + 1 }));
    ws.subscribed = want;
  }

  onKline(market, d) {
    const k = d.k;
    const id = `${market}:${d.s}:${k.i}`;
    const e = this.watches.get(id);
    if (!e) return;
    const bar = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, closeTime: k.T, closed: k.x };
    this.pushBar(e, bar);
  }

  pushBar(e, bar) {
    e.lastTickAt = Date.now();
    const arr = e.candles;
    const last = arr[arr.length - 1];
    let closedNow = false;
    if (last && last.t === bar.t) {
      const wasOpen = !last.closed;
      arr[arr.length - 1] = bar;
      closedNow = wasOpen && bar.closed;
    } else if (!last || bar.t > last.t) {
      if (last && !last.closed) { last.closed = true; closedNow = true; }
      arr.push(bar);
      if (arr.length > MAX_BARS) arr.shift();
    }
    this.run(e, closedNow);
  }

  // ── polling path: forex always, and any stream that goes silent ──
  startPoll(e) {
    if (e.pollTimer) return;
    // Binance klines cost weight 2 against a 6000/min budget, so poll hard —
    // a 3m alarm can't afford a 60s blind spot. Twelve Data's free tier only
    // allows 8 req/min, so forex stays slow.
    const ms = e.watch.market === 'forex'
      ? Math.max(30000, intervalMin(e.watch.interval) * 60000 / 3)
      : 12000;
    e.pollTimer = setInterval(async () => {
      try {
        const fresh = await fetchCandles(e.watch.market, e.watch.symbol, e.watch.interval, MAX_BARS);
        const prevLastClosed = e.candles.filter(c => c.closed).at(-1)?.t;
        e.candles = fresh;
        e.error = null;
        e.lastPollAt = Date.now();
        const nowLastClosed = fresh.filter(c => c.closed).at(-1)?.t;
        this.run(e, prevLastClosed !== nowLastClosed);
      } catch (err) {
        e.error = err.message;
        this.emit('error', e.watch.id, err.message);
      }
    }, ms);
  }

  // ── analysis + event detection ──
  run(e, force = false) {
    const now = Date.now();
    if (!force && now - (e.lastRun || 0) < ANALYZE_THROTTLE) return;
    e.lastRun = now;

    let a;
    try { a = analyze(e.candles, { ...this.getGlobalCfg(), ...(e.watch.cfg || {}) }); }
    catch (err) { e.error = err.message; return; }
    if (!a) return;

    const prev = e.last;
    e.last = a;
    e.error = null;

    // Bar indices shift whenever the candle array rolls or a REST poll replaces
    // it with a different window, so trades are identified by their candle
    // timestamp instead — otherwise the same exit alerts twice.
    // ENTRY — a position opened on the newest closed bar
    if (a.position && a.position.entryBar === a.lastClosedBar && e.marks.entryTime !== a.position.entryTime) {
      e.marks.entryTime = a.position.entryTime;
      e.marks.preAlertAt = 0;
      this.emit('signal', 'ENTRY', e.watch, a);
    }
    if (a.position) e.marks.entryTime = a.position.entryTime;

    // EXIT — a trade closed on the newest closed bar
    const lastTrade = a.trades[a.trades.length - 1];
    if (lastTrade && lastTrade.exitBar === a.lastClosedBar && e.marks.exitTime !== lastTrade.exitTime) {
      e.marks.exitTime = lastTrade.exitTime;
      this.emit('signal', 'EXIT', e.watch, { ...a, justClosed: lastTrade });
    }

    // PRE-ALERT — signal is close to triggering
    const f = a.forecast;
    if (f?.imminent && !a.position) {
      const stale = now - (e.marks.preAlertAt || 0) > PREALERT_COOLDOWN;
      const sideChanged = e.marks.preAlertSide !== f.side;
      if (stale || sideChanged) {
        e.marks.preAlertAt = now;
        e.marks.preAlertSide = f.side;
        this.emit('signal', 'PREALERT', e.watch, a);
      }
    }

    this.emit('update', e.watch.id, a);
  }

  snapshot() {
    return [...this.watches.values()].map(e => ({
      ...e.watch,
      loading: e.loading, error: e.error,
      maxLev: maxLev(e.watch.market, e.watch.symbol),
      source: e.watch.market === 'forex' ? 'poll' : e.streamDead ? 'poll (stream blocked)' : 'stream',
      analysis: e.last ? slim(e.last) : null
    }));
  }
}

function slim(a) {
  return {
    price: a.price, rsi: a.rsi, atrPct: a.atrPct, volRatio: a.volRatio,
    emaFast: a.emaFast, emaSlow: a.emaSlow, macdHist: a.macdHist,
    position: a.position, forecast: a.forecast, profile: a.profile, calibration: a.calibration, regime: a.regime, stats: a.stats,
    recent: a.trades.slice(-10).reverse(),
    lastClosedTime: a.lastClosedTime
  };
}
