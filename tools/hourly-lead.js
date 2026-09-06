#!/usr/bin/env node
// Does hour-based volatility warn you a day BEFORE the big daily move?
//
// The claim: COLLECT ran ~80% today, BULLA pumped yesterday, and in both cases
// the hourly candles were already wide the day before — so a coin whose 1h
// volatility wakes up is a coin to be in tomorrow.
//
// Two modes, because a claim like this needs both halves:
//
//   node tools/hourly-lead.js COLLECTUSDT BULLAUSDT
//     The case study. Every hour of the day before the move, measured against
//     that coin's own quiet baseline, so "wide" means wide FOR THIS COIN.
//
//   node tools/hourly-lead.js --scan --days 30
//     The honest test. Over the whole board: how often does a hot-hours day
//     actually lead to a big next day, versus how often a big day happens
//     anyway. A signal that fires on 60% of days and is right 30% of the time
//     is worse than useless, and only this mode can tell you that.
//
// The scan deliberately reports the sub-case where the warning day was itself
// quiet. Volatility clusters — a coin that just moved 40% will move again — so
// counting those days would let the signal take credit for yesterday's news.

import '../src/env.js';
import fs from 'fs';
import { fetchCandles, fetchCandlesDeep, ticker24h } from '../src/providers.js';

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(`--${n}`);

const MARKET = flag('market', 'futures');
const BIG = +flag('big', 25);      // a "big move" = day range this % of its low
const RATIO = +flag('ratio', 2);   // an hour is "hot" at this × the coin's median hour
const HOT = +flag('hot', 3);       // a day is "hot" with this many hot hours
const DAY = 864e5;
const dayOf = t => Math.floor(t / DAY) * DAY;
const iso = t => new Date(t).toISOString().slice(0, 10);
const hh = t => new Date(t).toISOString().slice(11, 13) + ':00';
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// One hour, described three ways: how far it travelled, how far it CLOSED, and
// how that compares to the same coin on a normal hour.
function hours(bars, baseFrom = 0) {
  const base = bars.filter(b => b.t < baseFrom || !baseFrom);
  const medRange = median(base.map(b => b.l > 0 ? (b.h - b.l) / b.l * 100 : 0).filter(v => v > 0));
  const medVol = median(base.map(b => b.v).filter(v => v > 0));
  return bars.map(b => ({
    t: b.t,
    rangePct: b.l > 0 ? (b.h - b.l) / b.l * 100 : 0,
    chgPct: b.o > 0 ? (b.c - b.o) / b.o * 100 : 0,
    v: b.v,
    rr: medRange > 0 ? (b.h - b.l) / b.l * 100 / medRange : 0,
    vr: medVol > 0 ? b.v / medVol : 0,
    c: b.c
  }));
}

// Daily bars rolled up from the hourly ones, so both views share one source.
function days(bars) {
  const m = new Map();
  for (const b of bars) {
    const d = dayOf(b.t);
    const e = m.get(d) || { d, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, hrs: [] };
    e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); e.c = b.c; e.v += b.v; e.hrs.push(b);
    m.set(d, e);
  }
  return [...m.values()].sort((a, b) => a.d - b.d).map(e => ({
    ...e,
    rangePct: e.l > 0 ? (e.h - e.l) / e.l * 100 : 0,
    chgPct: e.o > 0 ? (e.c - e.o) / e.o * 100 : 0
  }));
}

async function caseStudy(symbol) {
  const bars = (await fetchCandlesDeep(MARKET, symbol, '1h', 1100)).filter(b => b.closed);
  if (bars.length < 120) return console.log(`\n  ${symbol}: only ${bars.length} hourly bars — too new to judge\n`);
  const D = days(bars);
  const listed = D.length;

  // The move day: biggest range in the recent window, unless one is named.
  const want = flag('day', '');
  const recent = D.slice(-(+flag('lookback', 6)));
  const move = want ? D.find(d => iso(d.d) === want) : recent.reduce((a, b) => b.rangePct > a.rangePct ? b : a);
  if (!move) return console.log(`  ${symbol}: no day ${want}`);
  const prev = D.find(d => d.d === move.d - DAY);

  const t = await ticker24h(MARKET, symbol).catch(() => null);
  console.log(`\n\n══ ${symbol} · ${MARKET} ${t ? `· now ${t.price} · 24h ${pct(t.changePct)} · $${(t.volume / 1e6).toFixed(1)}M` : ''}`);
  console.log(`   ${listed} days of hourly history\n`);

  console.log('   day          open→close      low→high   volume vs 30d   hot hours (≥' + RATIO + '× its own median)');
  for (const d of D.slice(-10)) {
    const past = bars.filter(b => b.t < d.d);
    const H = hours(d.hrs.concat(), 0);
    const medV = median(past.map(b => b.v).filter(v => v > 0));
    const medR = median(past.map(b => b.l > 0 ? (b.h - b.l) / b.l * 100 : 0).filter(v => v > 0));
    const hot = medR > 0 ? H.filter(h => h.rangePct / medR >= RATIO).length : 0;
    const mark = d.d === move.d ? ' ← the move' : d.d === move.d - DAY ? ' ← day before' : '';
    console.log(`   ${iso(d.d)}   ${pct(d.chgPct).padStart(9)}   ${d.rangePct.toFixed(1).padStart(9)}%   ` +
      `${(medV > 0 ? (d.v / medV / 24).toFixed(1) + '×' : '—').padStart(8)}        ${String(hot).padStart(2)}/24${mark}`);
  }

  if (!prev) return console.log('\n   no full day before it in the window\n');

  // Baseline = everything before the day we are judging, so nothing from the
  // move itself leaks into "normal for this coin".
  const H = hours(bars, prev.d);
  const win = H.filter(h => h.t >= prev.d && h.t < move.d + 12 * 3600e3);
  console.log(`\n   hour by hour — ${iso(prev.d)} (the day before) into the first 12h of the move`);
  console.log('   UTC     range    vs median    volume     move      note');
  let firstHot = null, firstIgnite = null;
  for (const h of win) {
    const inMove = h.t >= move.d;
    if (!inMove && !firstHot && h.rr >= RATIO && h.vr >= 1.5) firstHot = h;
    if (inMove && !firstIgnite && h.rangePct >= 8) firstIgnite = h;
    const note = !inMove && firstHot === h ? '← hourly volatility wakes up'
      : inMove && firstIgnite === h ? '← the move itself'
      : h.rr >= RATIO ? 'hot' : '';
    console.log(`   ${inMove ? '*' : ' '}${hh(h.t)}  ${h.rangePct.toFixed(2).padStart(6)}%  ` +
      `${h.rr.toFixed(1).padStart(6)}×    ${h.vr.toFixed(1).padStart(5)}×   ${pct(h.chgPct).padStart(8)}   ${note}`);
  }

  console.log(`\n   verdict for ${symbol}:`);
  if (!firstHot) {
    console.log(`   nothing woke up the day before — the ${move.rangePct.toFixed(0)}% day on ${iso(move.d)} arrived cold.`);
  } else {
    const lead = firstIgnite ? (firstIgnite.t - firstHot.t) / 3600e3 : null;
    const drift = firstIgnite ? (firstIgnite.c - firstHot.c) / firstHot.c * 100 : null;
    console.log(`   warning at ${hh(firstHot.t)} UTC on ${iso(firstHot.t)} (${firstHot.rr.toFixed(1)}× its normal hour, ${firstHot.vr.toFixed(1)}× volume)`);
    if (lead !== null) console.log(`   the move's first big hour came ${lead}h later, ${pct(drift)} away in price`);
    console.log(`   the day itself: ${pct(move.chgPct)} close, ${move.rangePct.toFixed(0)}% low→high — direction was ${move.chgPct >= 0 ? 'UP' : 'DOWN'}`);
  }
}

// ─── the honest test ───
async function scan() {
  const days = +flag('days', 30);
  const N = +flag('coins', 150);
  const need = (days + 20) * 24;

  const src = MARKET === 'futures' ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
  const tick = await (await fetch(`${src}/ticker/24hr`)).json();
  const universe = tick
    .filter(t => t.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, N)
    .map(t => t.symbol);

  const cells = [];   // one per coin-day: was yesterday hot, was today big
  let coins = 0;
  for (const sym of universe) {
    let bars = null;
    try { bars = (await fetchCandlesDeep(MARKET, sym, '1h', need)).filter(b => b.closed); } catch { }
    if (!bars || bars.length < need * 0.6) { process.stderr.write('·'); continue; }
    coins++;
    const D = days2(bars);
    for (let i = 1; i < D.length; i++) {
      const y = D[i - 1], d = D[i];
      if (!y.full || !d.full) continue;
      // Baseline from the fortnight before the warning day — never from it.
      const past = bars.filter(b => b.t < y.d && b.t >= y.d - 14 * DAY);
      const medR = median(past.map(b => b.l > 0 ? (b.h - b.l) / b.l * 100 : 0).filter(v => v > 0));
      if (!(medR > 0) || past.length < 200) continue;
      const hotHrs = y.hrs.filter(b => b.l > 0 && (b.h - b.l) / b.l * 100 / medR >= RATIO).length;
      cells.push({ sym, day: d.d, hot: hotHrs >= HOT, hotHrs, warnQuiet: y.rangePct < BIG, big: d.rangePct >= BIG, range: d.rangePct, yRange: y.rangePct });
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  const rate = (rows, f = () => true) => {
    const s = rows.filter(f);
    return { n: s.length, big: s.filter(r => r.big).length, p: s.length ? s.filter(r => r.big).length / s.length * 100 : 0 };
  };
  const show = (label, r, base) => console.log(
    `   ${label.padEnd(42)} ${String(r.big).padStart(5)} / ${String(r.n).padEnd(6)} = ${r.p.toFixed(1).padStart(5)}%` +
    (base ? `   ${(r.p / base).toFixed(2)}× the base rate` : ''));

  const all = rate(cells);
  console.log(`\n\n══ does a hot-hours day predict a big next day?`);
  console.log(`   ${MARKET} · top ${N} by volume (${coins} usable) · ${days}d · big move = ${BIG}% daily range`);
  console.log(`   hot hour = ${RATIO}× that coin's median hour · hot day = ${HOT}+ hot hours\n`);
  console.log('   condition                                   big / days     hit rate');
  show('any day (the base rate)', all);
  show('after a hot-hours day', rate(cells, r => r.hot), all.p);
  show('after a quiet-hours day', rate(cells, r => !r.hot), all.p);
  console.log();
  const q = cells.filter(r => r.warnQuiet);
  const qb = rate(q);
  console.log('   …with the warning day itself still calm (no leakage from a move already underway)');
  show('any calm day', qb);
  show('calm day, but hours hot', rate(q, r => r.hot), qb.p);
  show('calm day, hours quiet', rate(q, r => !r.hot), qb.p);

  const big = cells.filter(r => r.big);
  console.log(`\n   coverage: ${big.filter(r => r.hot).length}/${big.length} big days ` +
    `(${(big.filter(r => r.hot).length / Math.max(1, big.length) * 100).toFixed(0)}%) had a hot-hours day before them`);
  const fired = cells.filter(r => r.hot);
  console.log(`   cost: the signal fires on ${fired.length}/${cells.length} coin-days (${(fired.length / cells.length * 100).toFixed(0)}% of the time)`);
  console.log(`   so ${fired.length - fired.filter(r => r.big).length} of ${fired.length} fires were followed by an ordinary day.\n`);
}

// ─── what the alarm would actually fire on ───
// The scan above judges a whole day. An alarm cannot wait for the day to end,
// so this measures the thing a live sweep can see: the hour where a calm coin
// first goes wide on real volume. Same 30 days, but the outcome is what the
// next 24 hours paid from that hour's close — because that is the trade.
async function trigger() {
  const days = +flag('days', 30);
  const N = +flag('coins', 150);
  const need = (days + 16) * 24;
  const CACHE = flag('cache', '');

  // Every hour of every coin, reduced to the six numbers any threshold needs.
  // Cached, because the grid below has to walk them fifty times and refetching
  // 120 coins for each pass would take an afternoon.
  let hours = [], coins = 0;
  if (CACHE && fs.existsSync(CACHE)) {
    ({ hours, coins } = JSON.parse(fs.readFileSync(CACHE, 'utf8')));
    process.stderr.write(`[trigger] ${hours.length} hours from cache (${coins} coins)\n`);
  } else {
    const src = MARKET === 'futures' ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
    const tick = await (await fetch(`${src}/ticker/24hr`)).json();
    const universe = tick
      .filter(t => t.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
      .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
      .slice(0, N).map(t => t.symbol);

    for (const sym of universe) {
      let bars = null;
      try { bars = (await fetchCandlesDeep(MARKET, sym, '1h', need)).filter(b => b.closed); } catch { }
      if (!bars || bars.length < need * 0.6) { process.stderr.write('·'); continue; }
      coins++;
      const rng = bars.map(b => b.l > 0 ? (b.h - b.l) / b.l * 100 : 0);
      const vols = bars.map(b => b.v);

      for (let i = 336; i < bars.length - 24; i++) {
        const medR = median(rng.slice(i - 336, i));
        const medV = median(vols.slice(i - 336, i));
        if (!(medR > 0) || !(medV > 0)) continue;

        const dayR = [];
        for (let d = 1; d <= 14; d++) {
          const w = bars.slice(i - d * 24, i - (d - 1) * 24);
          if (w.length < 20) continue;
          const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
          if (lo > 0) dayR.push((hi - lo) / lo * 100);
        }

        const fwd = bars.slice(i + 1, i + 25);
        const c = bars[i].c;
        hours.push({
          sym,
          rr: rng[i] / medR,
          vr: vols[i] / medV,
          calm6: median(rng.slice(i - 6, i)) / medR,
          calm12: median(rng.slice(i - 12, i)) / medR,
          daily: median(dayR),
          up: (Math.max(...fwd.map(b => b.h)) - c) / c * 100,
          dn: (c - Math.min(...fwd.map(b => b.l))) / c * 100,
          wasUp: bars[i].c >= bars[i].o
        });
      }
      process.stderr.write('.');
    }
    process.stderr.write('\n');
    if (CACHE) fs.writeFileSync(CACHE, JSON.stringify({ coins, hours }));
  }

  hours.forEach(h => { h.best = Math.max(h.up, h.dn); });
  const every = hours;
  const hit = (h, c) => h.rr >= c.rr && h.vr >= c.vr && h[c.calmKey] < c.calm && h.daily >= c.daily;

  // Which thresholds are worth waking up for? An alarm is only as good as the
  // gap between its hit rate and the base rate, PRICED IN alarms per day —
  // a 2× edge that fires seventy times a day is not an edge you can act on.
  if (has('grid')) {
    const base = every.filter(h => h.best >= 20).length / every.length * 100;
    console.log(`\n\n══ tuning the alarm · ${coins} coins · ${days}d · base rate ${base.toFixed(1)}% of hours see a 20% move in the next 24h\n`);
    console.log('   ratio  vol  calm(6h)  day%    fires    ≥10%    ≥20%   lift   alarms/day');
    const out = [];
    for (const rr of [2, 3, 4, 5, 6])
      for (const vr of [2, 3, 5])
        for (const calm of [1.3, 1.0, 0.8])
          for (const daily of [6, 10, 15]) {
            const c = { rr, vr, calm, daily, calmKey: 'calm6' };
            const f = every.filter(h => hit(h, c));
            if (f.length < 30) continue;
            const p20 = f.filter(h => h.best >= 20).length / f.length * 100;
            const p10 = f.filter(h => h.best >= 10).length / f.length * 100;
            out.push({ rr, vr, calm, daily, n: f.length, p10, p20, lift: p20 / base, perDay: f.length / coins / days });
          }
    for (const r of out.sort((a, b) => b.lift - a.lift).slice(0, 18))
      console.log(`   ${String(r.rr).padStart(4)}  ${String(r.vr).padStart(3)}  ${String(r.calm).padStart(7)}  ${String(r.daily).padStart(4)}  ` +
        `${String(r.n).padStart(6)}  ${r.p10.toFixed(1).padStart(5)}%  ${r.p20.toFixed(1).padStart(5)}%  ${r.lift.toFixed(2)}×  ` +
        `${(r.perDay * coins).toFixed(1).padStart(6)} across the board`);
    console.log();
    return;
  }

  const MIN_DAILY = +flag('minDaily', 6);
  const CALM = +flag('calm', 1.3);
  const VOLX = +flag('volx', 2);
  const fires = every.filter(h => hit(h, { rr: RATIO, vr: VOLX, calm: CALM, daily: MIN_DAILY, calmKey: 'calm6' }));

  const share = (rows, f) => rows.length ? rows.filter(f).length / rows.length * 100 : 0;
  const line = (label, rows) => console.log(
    `   ${label.padEnd(26)} ${String(rows.length).padStart(6)}   ` +
    `${median(rows.map(r => r.up)).toFixed(1).padStart(6)}%  ${median(rows.map(r => r.dn)).toFixed(1).padStart(6)}%   ` +
    `${share(rows, r => r.best >= 10).toFixed(1).padStart(5)}%  ${share(rows, r => r.best >= 20).toFixed(1).padStart(5)}%`);

  console.log(`\n\n══ the alarm's own trigger, measured`);
  console.log(`   ${MARKET} · top ${N} (${coins} usable) · ${days}d · fires when a calm hour goes ${RATIO}× wide on ${VOLX}× volume`);
  console.log(`   and only on coins whose median day already ranges ${MIN_DAILY}%+\n`);
  console.log('   from that hour\'s close        hours     med up     med dn    ≥10% move  ≥20%');
  line('every hour (base rate)', every);
  line('when the alarm fires', fires);
  const upFires = fires.filter(r => r.wasUp), dnFires = fires.filter(r => !r.wasUp);
  console.log();
  line('…trigger hour closed up', upFires);
  line('…trigger hour closed down', dnFires);
  console.log(`\n   the trigger hour's own direction ${
    Math.abs(median(upFires.map(r => r.up)) - median(dnFires.map(r => r.up))) < 1
      ? 'tells you nothing about which way the next 24h goes'
      : 'leans ' + (median(upFires.map(r => r.up)) > median(dnFires.map(r => r.up)) ? 'with it' : 'against it')}`);
  console.log(`   it fires ${(fires.length / Math.max(1, every.length) * 100).toFixed(1)}% of all hours — ` +
    `about ${(fires.length / Math.max(1, coins) / days).toFixed(1)} alarms per coin per day\n`);
}

// day roll-up that also knows whether the day is complete (scan needs that)
function days2(bars) {
  const m = new Map();
  for (const b of bars) {
    const d = dayOf(b.t);
    const e = m.get(d) || { d, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, hrs: [] };
    e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); e.c = b.c; e.v += b.v; e.hrs.push(b);
    m.set(d, e);
  }
  return [...m.values()].sort((a, b) => a.d - b.d).map(e => ({
    ...e, full: e.hrs.length >= 22,
    rangePct: e.l > 0 ? (e.h - e.l) / e.l * 100 : 0,
    chgPct: e.o > 0 ? (e.c - e.o) / e.o * 100 : 0
  }));
}

const symbols = process.argv.slice(2).filter(a => /^[A-Z0-9]+USDT$/i.test(a)).map(s => s.toUpperCase());
if (has('trigger')) await trigger();
else if (has('scan')) await scan();
else if (symbols.length) for (const s of symbols) await caseStudy(s);
else console.log('usage: node tools/hourly-lead.js SYMBOLUSDT [...]  |  --scan --days 30  |  --trigger --days 30');
