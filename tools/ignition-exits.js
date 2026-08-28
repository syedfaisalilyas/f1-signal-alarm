#!/usr/bin/env node
// Which exit rule keeps the tail?
//
// The fixed TP2 banks two box-heights and hands back everything after it. On a
// coin that goes +200% that is most of the trade. This replays the same
// entries from data/ignition-windows.json under different exits, so the choice
// is settled by the same 2,510 trades rather than by argument.

import fs from 'fs';
import { maxLev, hydrate } from '../src/leverage.js';

try { hydrate(JSON.parse(fs.readFileSync('cloud/leverage.json', 'utf8'))); } catch { /* defaults */ }
const W = JSON.parse(fs.readFileSync('data/ignition-windows.json', 'utf8'));

// Every rule sees the same bars in the same order and must decide with only
// what has happened so far — no peeking at the eventual high.
function replay(w, rule) {
  const long = w.side === 'LONG';
  const fill = w.fill;
  const risk = Math.abs(fill - w.stop);
  if (!(risk > 0)) return null;
  const fav = p => (long ? p - fill : fill - p) / fill * 100;   // % in your favour
  const adv = p => (long ? fill - p : p - fill) / fill * 100;   // % against you

  let stop = w.stop, peak = fill, booked = 0, size = 1, mae = 0, mfe = 0;
  for (const [t, h, l, c] of w.bars) {
    const hi = long ? h : l, lo = long ? l : h;      // "hi" = the good direction
    const a = adv(lo);
    if (a > mae) mae = a;
    const g = fav(hi);
    if (g > mfe) mfe = g;

    // Stop is checked before the extension, so a bar that takes out the stop
    // and then runs is a loss, not a win.
    const hitStop = long ? l <= stop : h >= stop;
    if (hitStop) return { pnl: booked + size * fav(stop), mae, mfe, exit: 'trail', exitTime: t, exitPrice: stop };

    peak = long ? Math.max(peak, h) : Math.min(peak, l);
    const r = rule(fav(peak) / (risk / fill * 100));   // progress in R

    if (r.takeAt && size === 1 && (long ? h >= r.takeAt : l <= r.takeAt)) {
      booked += 0.5 * fav(r.takeAt); size = 0.5;
    }
    if (r.exitAt && (long ? h >= r.exitAt : l <= r.exitAt)) {
      return { pnl: booked + size * fav(r.exitAt), mae, mfe, exit: 'target', exitTime: t, exitPrice: r.exitAt };
    }
    if (r.trailFrom != null) {
      const t = long ? peak * (1 - r.trailFrom) : peak * (1 + r.trailFrom);
      stop = long ? Math.max(stop, t) : Math.min(stop, t);
    }
    if (r.trailR != null && fav(peak) > risk / fill * 100 * r.armAt) {
      const t = long ? peak - r.trailR * risk : peak + r.trailR * risk;
      stop = long ? Math.max(stop, t) : Math.min(stop, t);
    }
  }
  const last = w.bars.at(-1);
  return { pnl: booked + size * fav(last[3]), mae, mfe, exit: 'time', exitTime: last[0], exitPrice: last[3] };
}

const RULES = {
  'fixed TP2 (current)':      () => ({ exitAt: null, _: 0 }),
  'trail 2R after 1R':        () => ({ trailR: 2, armAt: 1 }),
  'trail 3R after 2R':        () => ({ trailR: 3, armAt: 2 }),
  'trail 15% from peak':      () => ({ trailFrom: 0.15 }),
  'trail 25% from peak':      () => ({ trailFrom: 0.25 }),
  'TP1 half, trail 25%':      () => ({ trailFrom: 0.25 }),
};

// The current rule needs the real tp2 level, which is per-trade.
const ruleFor = (name, w) => {
  if (name === 'fixed TP2 (current)') return () => ({ exitAt: w.tp2 });
  if (name === 'TP1 half, trail 25%') return () => ({ takeAt: w.tp1, trailFrom: 0.25 });
  return RULES[name];
};

const sum = a => a.reduce((s, v) => s + v, 0);
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n) => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(n);

console.log(`\n${W.length} trades · same entries, different exits\n`);
console.log(`  ${pad('exit rule', 24)}${'avg 1x'.padStart(9)}${'avg 10x'.padStart(10)}` +
  `${'avg MEXC max'.padStart(14)}${'win'.padStart(7)}${'best single'.padStart(14)}`);
console.log('  ' + '─'.repeat(78));

const keep = {};
for (const name of Object.keys(RULES)) {
  const res = W.map(w => {
    const r = replay(w, ruleFor(name, w));
    if (!r) return null;
    const lev = maxLev('futures', w.symbol) || 1;
    return {
      ...r, symbol: w.symbol, interval: w.interval, entryTime: w.entryTime, lev,
      at10: r.mae >= 10 ? -100 : r.pnl * 10,
      atMax: r.mae >= 100 / lev ? -100 : r.pnl * lev
    };
  }).filter(Boolean);
  keep[name] = res;
  console.log(`  ${pad(name, 24)}${num(sum(res.map(x => x.pnl)) / res.length, 9)}` +
    `${num(sum(res.map(x => x.at10)) / res.length, 10)}` +
    `${num(sum(res.map(x => x.atMax)) / res.length, 14)}` +
    `${((res.filter(x => x.pnl > 0).length / res.length * 100).toFixed(0) + '%').padStart(7)}` +
    `${num(Math.max(...res.map(x => x.atMax)), 14)}`);
}

const winner = Object.entries(keep).sort((a, b) =>
  sum(b[1].map(x => x.atMax)) - sum(a[1].map(x => x.atMax)))[0];
console.log(`\n  best by total return at MEXC max: ${winner[0]}\n`);

const top = [...winner[1]].sort((a, b) => b.atMax - a.atMax).slice(0, 10);
console.log(`  its ten biggest, vs what the fixed target got on the same trade:`);
for (const t of top) {
  const same = keep['fixed TP2 (current)'].find(x =>
    x.symbol === t.symbol && x.entryTime === t.entryTime && x.interval === t.interval);
  console.log(`  ${pad(t.symbol, 14)}${pad(t.interval, 5)}${(t.lev + 'x').padStart(6)}` +
    `${num(t.atMax, 12)}   was ${same ? num(same.atMax, 10) : '     —'}   exit ${t.exit}`);
}


// ── --board: the leaderboard, re-priced under the winning exit ──
if (process.argv.includes('--board')) {
  const TRAIL = 'trail 25% from peak', FIXED = 'fixed TP2 (current)';
  const rows = W.map(w => {
    const t = replay(w, ruleFor(TRAIL, w));
    const f = replay(w, ruleFor(FIXED, w));
    if (!t || !f) return null;
    const lev = maxLev('futures', w.symbol) || 1;
    const dead = t.mae >= 100 / lev;
    return {
      sym: w.symbol, tf: w.interval, side: w.side,
      et: w.entryTime, ep: w.fill, xt: t.exitTime, xp: t.exitPrice, why: t.exit,
      held: t.exitTime - w.entryTime,
      ran: +t.mfe.toFixed(1), got: +t.pnl.toFixed(1), dip: +t.mae.toFixed(2), lev,
      // The ceiling: the whole move at max leverage, i.e. selling the exact top
      // tick. Nobody hits it — it is here to size the trail against.
      peakMax: dead ? -100 : Math.round(t.mfe * lev),
      atMax: dead ? -100 : Math.round(t.pnl * lev),
      wasMax: f.mae >= 100 / lev ? -100 : Math.round(f.pnl * lev),
      survived: !dead
    };
  }).filter(Boolean);

  const sumBy = (a, k) => a.reduce((s, v) => s + v[k], 0);
  const top = rows.filter(r => r.survived).sort((a, b) => b.atMax - a.atMax).slice(0, 30);
  const caps = [5, 10, 20, 25, 50, 'max'].map(cap => {
    const v = W.map(w => {
      const t = replay(w, ruleFor(TRAIL, w)); if (!t) return null;
      const L = cap === 'max' ? (maxLev('futures', w.symbol) || 1) : Math.min(cap, maxLev('futures', w.symbol) || 1);
      return { p: t.mae >= 100 / L ? -100 : t.pnl * L, dead: t.mae >= 100 / L };
    }).filter(Boolean);
    return { cap: cap === 'max' ? 'MEXC max' : cap + 'x',
      avg: +(sum(v.map(x => x.p)) / v.length).toFixed(1),
      liqPct: +(v.filter(x => x.dead).length / v.length * 100).toFixed(0) };
  });
  const tfs = ['5m', '15m', '1h'].map(iv => {
    const t = rows.filter(r => r.tf === iv);
    const at = L => +(sumBy(t.map(r => ({ v: r.dip >= 100 / Math.min(L, r.lev) ? -100 : (r.got * Math.min(L, r.lev)) })), 'v') / t.length).toFixed(1);
    return { tf: iv, n: t.length,
      win: +(t.filter(r => r.got > 0).length / t.length * 100).toFixed(0),
      medRan: +([...t.map(r => r.ran)].sort((a, b) => a - b)[Math.floor(t.length / 2)]).toFixed(1),
      avg10: at(10), avgMax: +(sumBy(t, 'atMax') / t.length).toFixed(1) };
  });

  // Carry the rule comparison into the file too, so the page cannot quote a
  // number the run did not produce.
  const rules = Object.keys(RULES).map(name => {
    const r = W.map(w => {
      const x = replay(w, ruleFor(name, w)); if (!x) return null;
      const L = maxLev('futures', w.symbol) || 1;
      return { p: x.mae >= 100 / L ? -100 : x.pnl * L, win: x.pnl > 0 };
    }).filter(Boolean);
    return { name, avg: +(sum(r.map(x => x.p)) / r.length).toFixed(1),
      win: +(r.filter(x => x.win).length / r.length * 100).toFixed(0),
      best: name === TRAIL };
  });

  fs.writeFileSync(process.env.TMPDIR + '/board.json',
    JSON.stringify({ n: rows.length, days: 45, rule: TRAIL, top, caps, tfs, rules }, null, 1));
  console.log(`\nboard.json written · ${rows.length} trades · top ${top.length}`);
  console.log('caps:', JSON.stringify(caps));
  console.log('tfs :', JSON.stringify(tfs));
}
