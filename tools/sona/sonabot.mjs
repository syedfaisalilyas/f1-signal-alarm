// sonabot — Sona's method run by us, with her rules, on paper.
// Zones and setups come from zones.mjs; fills, candle-close stops and the
// "SL to entry, 50% book" rule from paper.mjs (the same book copysona uses).
//
//   node tools/sona/sonabot.mjs              run live on paper (MEXC prices)
//   node tools/sona/sonabot.mjs --backtest   replay the last year on Binance data
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { HOME, sleep, logger, loadJSON, saveJSON, candles, price, tgSend, esc } from './common.mjs';
import * as P from './paper.mjs';
import { setup, btcRegime, COINS } from './zones.mjs';
import { makeTicker } from './live.mjs';

const MAX_OPEN = 3, ORDER_TTL_H = 48;
const H4 = 4 * 3600e3;

// One scan: for every coin without a trade, place her two-entry orders at the
// nearest valid zone. `get4h(coin)` → closed 4H candles, `px(coin)` → price.
async function scan(book, get4h, regime, px, t, onOpen) {
  for (const coin of COINS) {
    if (book.positions.length >= MAX_OPEN) break;
    if (book.positions.some(p => p.coin === coin)) continue;
    const k4 = await get4h(coin);
    if (!k4 || k4.length < 100) continue;
    const s = setup(k4, await px(coin), regime);
    if (!s) continue;
    const p = P.open(book, { coin, side: s.side, e1: s.e1, e2: s.e2, sl: s.sl, tps: s.tps, src: 'zone', ttlH: ORDER_TTL_H, note: `zone ${P.fmt(s.zone.lo)}–${P.fmt(s.zone.hi)} ×${s.zone.touch}` });
    p.sl0 = s.sl;
    if (t) { p.createdAt = t; p.expiresAt = t + ORDER_TTL_H * 3600e3; }
    onOpen?.(p, s);
  }
}

// ── backtest ──────────────────────────────────────────────────────────────
async function binance(sym, interval, start, end) {
  const dir = join(HOME, 'data'); mkdirSync(dir, { recursive: true });
  const f = join(dir, `${sym}-${interval}-${start}-${end}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const out = []; let t = start;
  while (t < end) {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}USDT&interval=${interval}&startTime=${t}&limit=1500`);
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) break;
    out.push(...j.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] })));
    t = j.at(-1)[0] + 1;
    await sleep(120);
  }
  const res = out.filter(k => k.t < end);
  writeFileSync(f, JSON.stringify(res));
  return res;
}

async function backtest() {
  const END = Date.UTC(2026, 8, 27), START = Date.UTC(2025, 8, 27);
  const warm = START - 80 * 864e5;
  const d4 = {}, d30 = {};
  for (const c of COINS) { d4[c] = await binance(c, '4h', warm, END); d30[c] = await binance(c, '30m', START, END); }
  const btcD = await binance('BTC', '1d', warm, END);
  const book = P.makeBook('sonabot-bt', 100);
  const idx30 = Object.fromEntries(COINS.map(c => [c, new Map(d30[c].map((k, i) => [k.t, i]))]));
  const ptr4 = Object.fromEntries(COINS.map(c => [c, 0]));
  const log = [];
  for (let t = START; t < END; t += 1800e3) {
    const tClose = t + 1800e3;
    // 1. manage open trades on this 30m candle
    for (const p of [...book.positions]) {
      const i = idx30[p.coin].get(t);
      if (i == null) continue;
      const ev = P.onBar(book, p, { ...d30[p.coin][i], closed: true, t: tClose });
      for (const e of ev) log.push(`${new Date(tClose).toISOString().slice(0, 16)} ${e}`);
    }
    // 2. at every 4H close, look for new zones
    if (tClose % H4 === 0) {
      const days = btcD.filter(k => k.t + 864e5 <= tClose);
      const reg = btcRegime(days);
      await scan(book,
        c => { const a = d4[c]; while (ptr4[c] < a.length && a[ptr4[c]].t + H4 <= tClose) ptr4[c]++; return a.slice(Math.max(0, ptr4[c] - 400), ptr4[c]); },
        reg,
        c => { const i = idx30[c].get(t); return i == null ? NaN : d30[c][i].c; },
        tClose);
    }
  }
  // report
  const trades = book.history.filter(p => p.exits.length);
  const wins = trades.filter(p => p.realized > 0);
  const byMonth = {};
  for (const p of trades) { const m = new Date(p.closedAt).toISOString().slice(0, 7); (byMonth[m] ??= { n: 0, usdt: 0 }); byMonth[m].n++; byMonth[m].usdt += p.realized; }
  let eq = 100, peak = 100, dd = 0;
  for (const p of [...trades].sort((a, b) => a.closedAt - b.closedAt)) { eq += p.realized; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  const why = {}; for (const p of trades) { const k = p.exits.map(e => e.why.replace(/[\d.]+/g, '').trim()).join(' → '); why[k] = (why[k] || 0) + 1; }
  console.log(`sonabot backtest ${new Date(START).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)} · ${COINS.length} coins · ${P.SIZING} · fees ${P.FEE * 100}%/side`);
  console.log(`orders placed ${book.history.length + book.positions.length}, filled & closed ${trades.length}, never filled ${book.history.length - trades.length}`);
  console.log(`wins ${wins.length}/${trades.length} (${(wins.length / trades.length * 100).toFixed(0)}%) · avg ${(trades.reduce((s, p) => s + p.realized, 0) / trades.length).toFixed(2)} USDT/trade · liquidations ${trades.filter(p => /LIQUIDATED/.test(p.exitWhy)).length} · 100 → ${P.equity(book).toFixed(2)} USDT · max drawdown ${(dd * 100).toFixed(1)}%`);
  console.log('by month:', Object.entries(byMonth).map(([m, v]) => `${m} ${v.n} ${v.usdt >= 0 ? '+' : ''}${v.usdt.toFixed(1)}`).join(' | '));
  console.log('by side:', ['L', 'S'].map(s => { const t = trades.filter(p => p.side === s); return `${s} ${t.length} trades ${t.reduce((a, p) => a + p.realized, 0).toFixed(1)} USDT`; }).join(' | '));
  console.log('by coin:', COINS.map(c => { const t = trades.filter(p => p.coin === c); return `${c} ${t.length}/${t.reduce((a, p) => a + p.realized, 0).toFixed(1)}`; }).join(' '));
  console.log('how trades ended:'); for (const [k, v] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`);
  writeFileSync(join(HOME, 'sonabot-backtest.log'), log.join('\n'));
  // the last 90 days as the Sona tab's history (tools/sona/backfill.json → calls-sona.mjs)
  const toR = p => {
    const f = p.legs.filter(l => l.filled), q = f.reduce((s, l) => s + l.qty, 0), avg = f.reduce((s, l) => s + l.px * l.qty, 0) / q;
    const d = p.side === 'L' ? 1 : -1, risk = Math.abs(avg - p.sl0) * q;
    return +(p.exits.reduce((s, e) => s + (e.px - avg) * d * e.q, 0) / risk).toFixed(2);
  };
  const recent = trades.filter(p => p.closedAt > END - 90 * 864e5).map(p => ({
    coin: p.coin, side: p.side === 'L' ? 1 : -1, legs: p.legs.filter(l => l.filled).map(l => +l.px.toPrecision(6)),
    sl: +p.sl0.toPrecision(6), tp1: +p.tps[0].toPrecision(6), tp2: +p.tps[1].toPrecision(6), zone: p.note,
    filledAt: Math.min(...p.legs.filter(l => l.filled).map(l => l.at)), closedAt: p.closedAt,
    status: /TP2/.test(p.exitWhy) ? 'tp' : /entry/.test(p.exitWhy) ? 'be' : 'sl',
    tp1Hit: p.exits.some(e => /TP1/.test(e.why)), r: toR(p)
  }));
  const bf = join(dirname(fileURLToPath(import.meta.url)), 'backfill.json');
  const prev = existsSync(bf) ? JSON.parse(readFileSync(bf, 'utf8')) : {};
  writeFileSync(bf, JSON.stringify({ ...prev, strategy: { made: new Date().toISOString().slice(0, 10), from: new Date(END - 90 * 864e5).toISOString().slice(0, 10), to: new Date(END).toISOString().slice(0, 10), trades: recent } }));
  console.log(`backfill: ${recent.length} trades in the last 90 days → ${bf}`);
}

// ── live (paper) ──────────────────────────────────────────────────────────
async function live() {
  const log = logger('sonabot');
  const S = loadJSON('sonabot.json', { book: P.makeBook('sonabot', 100), lastScan: 0 });
  const save = () => saveJSON('sonabot.json', S);
  const ticker = makeTicker();
  const notify = lines => tgSend(`🤖 <b>sonabot</b> (paper)\n${lines.map(esc).join('\n')}`);
  log(`sonabot started (paper, ${P.SIZING}, ${COINS.length} coins); equity ${P.equity(S.book).toFixed(2)}`);
  await tgSend(`🟢 <b>sonabot</b> started — paper mode, trading Sona's zone method on ${COINS.length} coins.`);
  for (;;) {
    try {
      const ev = await ticker(S.book, log);
      if (ev.length) { save(); log('market', ev.join(' | ')); await notify(ev); }
      const h4 = Math.floor(Date.now() / H4) * H4;
      if (h4 > S.lastScan && Date.now() - h4 > 30e3) {
        S.lastScan = h4;
        const since = Math.floor((Date.now() - 75 * 864e5) / 1000);
        const btcD = (await candles('BTC', 'Day1', Math.floor((Date.now() - 30 * 864e5) / 1000))).filter(k => k.t + 864e5 <= Date.now());
        const reg = btcRegime(btcD);
        const opened = [];
        await scan(S.book,
          async c => (await candles(c, 'Hour4', since).catch(() => [])).filter(k => k.t + H4 <= Date.now()),
          reg, c => price(c), null,
          (p, s) => opened.push(`${p.coin} ${p.side === 'L' ? 'LONG' : 'SHORT'} orders ${P.fmt(s.e1)} / ${P.fmt(s.e2)} · SL ${P.fmt(s.sl)} (30m close) · TP ${s.tps.map(P.fmt).join(' / ')} · ${p.note}`));
        save();
        log(`scan: BTC regime ${reg > 0 ? 'longs' : reg < 0 ? 'shorts' : 'none'}`, opened.join(' | ') || 'no new setups');
        if (opened.length) await notify(opened);
      }
    } catch (e) { log('loop error', e.stack?.split('\n')[0] || e.message); }
    await sleep(20e3);
  }
}

if (process.argv[2] === '--backtest') await backtest(); else await live();
