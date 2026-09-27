// Confluence lab, step 2: which concepts and confluences actually pay.
//
//   node tools/lab/analyse.mjs
//
// Time split, oldest → newest:  PICK (rules chosen here) · CHECK (must still
// hold) · EXAM (last 60 days, looked at once, only for the finalists).

import fs from 'fs';
import path from 'path';

const CACHE = process.env.CACHE || path.join(process.cwd(), 'tools/data/lab');
const { events: E, made, days } = JSON.parse(fs.readFileSync(path.join(CACHE, 'events.json')));
const end = made / 1000, examFrom = end - 60 * 86400, checkFrom = examFrom - 30 * 86400;
const part = e => e.t >= examFrom ? 'exam' : e.t >= checkFrom ? 'check' : 'pick';
for (const e of E) e.p = part(e);
const TPS = ['0.5', '0.75', '1', '1.5', '2'];
const FEATS = Object.keys(E[0].conf);

const stat = (es, tp) => {
  if (!es.length) return { n: 0, wr: 0, avg: 0, lb: -9 };
  const r = es.map(e => e.r[tp]), avg = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - avg) ** 2, 0) / r.length);
  return { n: r.length, wr: r.filter(x => x > 0).length / r.length * 100, avg, lb: avg - 1.5 * sd / Math.sqrt(r.length) };
};
const fmt = s => s.n ? `${String(s.n).padStart(5)} ${s.wr.toFixed(0).padStart(3)}% ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)}R` : '    –            ';
const P = { pick: E.filter(e => e.p === 'pick'), check: E.filter(e => e.p === 'check'), exam: E.filter(e => e.p === 'exam') };
console.log(`${E.length} events · pick ${P.pick.length} · check ${P.check.length} · exam ${P.exam.length} (${days} days)`);

// 1. each concept alone
console.log('\n1. EACH CONCEPT ALONE — pick | check   (n, win%, avg R after fees)');
for (const k of [...new Set(E.map(e => e.k))]) for (const tp of TPS) {
  const a = stat(P.pick.filter(e => e.k === k), tp), b = stat(P.check.filter(e => e.k === k), tp);
  console.log(`  ${k.padEnd(9)} ${tp.padStart(4)}R | ${fmt(a)} | ${fmt(b)}`);
}

// 2. does each confluence help? avg R at 1R when it agrees vs opposes, per half
console.log('\n2. EACH CONFLUENCE — avg R at 1R target when it AGREES / is NEUTRAL / OPPOSES (pick | check)');
for (const f of FEATS) {
  const row = p => [1, 0, -1].map(v => { const s = stat(P[p].filter(e => e.conf[f] === v), '1'); return s.n >= 30 ? `${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)}(${s.n})` : '   –   '; }).join(' ');
  console.log(`  ${f.padEnd(8)} ${row('pick')}  |  ${row('check')}`);
}

// 3. rule search on PICK: concept × target × up to 3 required confluences
const conds = FEATS.flatMap(f => [[f, 1], [f, -1]]).map(([f, v]) => ({ f, v, name: `${f}${v > 0 ? '+' : '-'}`, ok: e => e.conf[f] === v }))
  .concat(FEATS.map(f => ({ f, v: 'nn', name: `${f}≠-`, ok: e => e.conf[f] !== -1 })));
const cands = [];
for (const k of [...new Set(E.map(e => e.k)), 'any']) {
  const base = P.pick.filter(e => k === 'any' || e.k === k);
  const R = TPS.map(tp => Float64Array.from(base, e => e.r[tp]));
  const M = conds.map(c => base.map(e => c.ok(e)));
  const test = (idx, cs) => {
    if (idx.length < 80) return;
    for (let t = 0; t < TPS.length; t++) {
      let s = 0, w = 0, s2 = 0;
      for (const j of idx) { const r = R[t][j]; s += r; s2 += r * r; if (r > 0) w++; }
      const n = idx.length, avg = s / n, wr = w / n * 100;
      if (wr >= 55 && avg > 0) {
        const sd = Math.sqrt(Math.max(0, s2 / n - avg * avg));
        cands.push({ k, tp: TPS[t], cs, s: { n, wr, avg, lb: avg - 1.5 * sd / Math.sqrt(n) } });
      }
    }
  };
  const all = base.map((_, j) => j);
  test(all, []);
  for (let a = 0; a < conds.length; a++) {
    const ia = all.filter(j => M[a][j]); if (ia.length < 80) continue;
    test(ia, [conds[a]]);
    for (let b = a + 1; b < conds.length; b++) {
      if (conds[b].f === conds[a].f) continue;
      const ib = ia.filter(j => M[b][j]); if (ib.length < 80) continue;
      test(ib, [conds[a], conds[b]]);
      for (let c = b + 1; c < conds.length; c++) {
        if (conds[c].f === conds[a].f || conds[c].f === conds[b].f) continue;
        test(ib.filter(j => M[c][j]), [conds[a], conds[b], conds[c]]);
      }
    }
  }
}
cands.sort((a, b) => b.s.lb - a.s.lb);
console.log(`\n3. RULE SEARCH — ${cands.length} rules pass on PICK (n≥80, win≥55%, avg>0). Top 25 by confidence, then CHECK:`);
const name = c => `${c.k} @${c.tp}R ${c.cs.map(x => x.name).join(' ') || '(no filter)'}`;
const survivors = [];
for (const c of cands.slice(0, 200)) {
  const es = P.check.filter(e => (c.k === 'any' || e.k === c.k) && c.cs.every(x => x.ok(e)));
  c.chk = stat(es, c.tp);
  if (c.chk.n >= 25 && c.chk.avg > 0 && c.chk.wr >= 55) survivors.push(c);
}
for (const c of cands.slice(0, 25)) console.log(`  ${name(c).padEnd(52)} pick ${fmt(c.s)} | check ${fmt(c.chk)}`);

// 4. finalists = survived CHECK; now the EXAM, once
console.log(`\n4. FINALISTS (${survivors.length} survived CHECK) — EXAM on the last 60 days, never seen before:`);
for (const c of survivors.slice(0, 15)) {
  const es = P.exam.filter(e => (c.k === 'any' || e.k === c.k) && c.cs.every(x => x.ok(e)));
  c.exam = stat(es, c.tp);
  console.log(`  ${name(c).padEnd(52)} pick ${fmt(c.s)} | check ${fmt(c.chk)} | EXAM ${fmt(c.exam)}`);
}

// 5. the "highly confirmed" idea: count of agreeing confluences, weights from PICK
const w = {};
for (const f of FEATS) { const a = stat(P.pick.filter(e => e.conf[f] === 1), '1'), o = stat(P.pick.filter(e => e.conf[f] === -1), '1'); w[f] = a.n >= 50 && o.n >= 50 ? Math.sign(a.avg - o.avg) : a.n >= 50 ? Math.sign(a.avg - stat(P.pick.filter(e => e.conf[f] === 0), '1').avg) : 0; }
const score = e => FEATS.reduce((s, f) => s + w[f] * e.conf[f], 0);
console.log(`\n5. CONFLUENCE SCORE (weights learned on PICK: ${FEATS.filter(f => w[f]).map(f => (w[f] > 0 ? '+' : '-') + f).join(' ')})`);
for (const tp of ['0.5', '0.75', '1', '1.5']) for (const th of [2, 3, 4, 5, 6, 7]) {
  const f = p => stat(P[p].filter(e => score(e) >= th), tp);
  console.log(`  score≥${th} @${tp}R  pick ${fmt(f('pick'))} | check ${fmt(f('check'))} | exam ${fmt(f('exam'))}`);
}
fs.writeFileSync(path.join(CACHE, 'finalists.json'), JSON.stringify({ w, survivors: survivors.slice(0, 15).map(c => ({ rule: name(c), pick: c.s, check: c.chk, exam: c.exam })) }, null, 1));
