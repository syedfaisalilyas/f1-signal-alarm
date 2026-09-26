// What separates the A+ calls that hit TP from the ones that got stopped?
// Reads trades.json from tools/calls-backtest.mjs, splits it in time (older
// half = learn, newer half = check), and prints:
//   1. results per class under each exit (TP 1R … 3R, breakeven at +1R)
//   2. every entry condition, bucketed, with learn / check expectancy
//   3. a greedy filter set picked on the learn half only, scored on check
//
//   CACHE=… node tools/calls-learn.mjs [--cls=crypto] [--exit=2.5|be]

import fs from 'fs';
import path from 'path';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] ?? d;
const CACHE = process.env.CACHE || path.join(process.cwd(), 'tools/data/calls-bt');
const CLS = arg('cls', ''), EXIT = arg('exit', '2.5');
let T = JSON.parse(fs.readFileSync(path.join(CACHE, 'trades.json')));
if (CLS) T = T.filter(t => t.cls === CLS);
T.sort((a, b) => a.t - b.t);
const cut = T[Math.floor(T.length / 2)]?.t;
const learnSet = T.filter(t => t.t < cut), check = T.filter(t => t.t >= cut);
const R = (t, ex = EXIT) => ex === 'be' ? t.be : t.r[ex];
const avg = (a, ex) => a.length ? a.reduce((s, t) => s + R(t, ex), 0) / a.length : NaN;
const win = (a, ex) => a.length ? a.filter(t => R(t, ex) > 0).length / a.length * 100 : NaN;
const f2 = x => isNaN(x) ? '   –  ' : (x >= 0 ? '+' : '') + x.toFixed(2);
const day = t => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

console.log(`${T.length} trades${CLS ? ' (' + CLS + ')' : ''} · learn ${learnSet.length} (${day(T[0].t)} → ${day(cut)}) · check ${check.length} (→ ${day(T.at(-1).t)}) · exit ${EXIT}`);

console.log('\n1) Exits — avg R per trade after costs (learn | check)');
for (const cls of [...new Set(T.map(t => t.cls))]) {
  const a = learnSet.filter(t => t.cls === cls), b = check.filter(t => t.cls === cls);
  console.log(`  ${cls.padEnd(7)} n=${String(a.length).padStart(4)}|${String(b.length).padEnd(4)} ` +
    ['1', '1.5', '2', '2.5', '3', 'be'].map(ex => `${ex === 'be' ? 'BE' : ex + 'R'} ${f2(avg(a, ex))}|${f2(avg(b, ex))} (${win(b, ex).toFixed(0)}%)`).join('  '));
}
const fees = T.map(t => t.fee).sort((a, b) => a - b);
console.log(`  fee per trade in R: median ${fees[fees.length >> 1]}, 90th pct ${fees[Math.floor(fees.length * 0.9)]}`);

// buckets: categorical as-is, numeric by learn-set terciles
const keys = Object.keys(T[0].f);
const cuts = {};
for (const k of keys) {
  const v = learnSet.map(t => t.f[k]).filter(x => typeof x === 'number').sort((a, b) => a - b);
  if (v.length > 30) cuts[k] = [v[Math.floor(v.length / 3)], v[Math.floor(v.length * 2 / 3)]];
}
const bucket = (k, x) => x == null ? 'n/a' : cuts[k] ? (x < cuts[k][0] ? `low <${cuts[k][0]}` : x < cuts[k][1] ? `mid` : `high ≥${cuts[k][1]}`) : String(x);

console.log('\n2) Entry conditions — avg R learn | check (n)');
const rules = [];
for (const k of keys) {
  const vals = [...new Set(T.map(t => bucket(k, t.f[k])))];
  if (vals.length < 2) continue;
  const line = vals.map(v => {
    const a = learnSet.filter(t => bucket(k, t.f[k]) === v), b = check.filter(t => bucket(k, t.f[k]) === v);
    rules.push({ k, v, a, b });
    return `${v}: ${f2(avg(a))}|${f2(avg(b))} (${a.length}|${b.length})`;
  }).join('   ');
  console.log(`  ${k.padEnd(9)} ${line}`);
}

console.log('\n3) Greedy filters chosen on LEARN only, scored on CHECK');
let keepA = learnSet, keepB = check;
const chosen = [];
console.log(`  start                         learn ${f2(avg(keepA))} n=${keepA.length}   check ${f2(avg(keepB))} n=${keepB.length}  win ${win(keepB).toFixed(0)}%`);
for (let step = 0; step < 6; step++) {
  let best = null;
  for (const r of rules) {
    if (chosen.some(c => c.k === r.k && c.v === r.v)) continue;
    const a = keepA.filter(t => bucket(r.k, t.f[r.k]) !== r.v);
    if (a.length < learnSet.length * 0.2) continue;
    const gain = avg(a) - avg(keepA);
    if (!best || gain > best.gain) best = { ...r, gain, a };
  }
  if (!best || best.gain < 0.03) break;
  chosen.push(best);
  keepA = best.a;
  keepB = keepB.filter(t => bucket(best.k, t.f[best.k]) !== best.v);
  console.log(`  drop ${`${best.k}=${best.v}`.padEnd(24)} learn ${f2(avg(keepA))} n=${keepA.length}   check ${f2(avg(keepB))} n=${keepB.length}  win ${win(keepB).toFixed(0)}%`);
}
fs.writeFileSync(path.join(CACHE, `learned${CLS ? '-' + CLS : ''}.json`), JSON.stringify({ cuts, chosen: chosen.map(c => ({ k: c.k, v: c.v })) }, null, 1));
