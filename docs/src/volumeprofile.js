// Fixed-range volume profile — the JS twin of the block in in1.pine.
// Price stalls at high-volume nodes (accepted value) and slices through thin
// areas, so targets are read off volume shelves rather than a fixed R multiple.

export const VP_DEFAULTS = {
  tpMode: 'profile',    // 'profile' | 'rr'
  vpLen: 150,           // the "fixed range"
  vpRows: 30,
  vaPct: 70,
  hvnThr: 0.55,         // a row is a shelf at/above this share of POC volume
  minTpAtr: 0.8,        // ignore nodes sitting on top of entry
  fallbackRR: 2.0
};

export function buildProfile(candles, endIdx, cfg = {}) {
  const { vpLen, vpRows, vaPct, hvnThr } = { ...VP_DEFAULTS, ...cfg };
  const start = Math.max(0, endIdx - vpLen + 1);
  const win = candles.slice(start, endIdx + 1);
  if (win.length < 10) return null;

  let hi = -Infinity, lo = Infinity;
  for (const b of win) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  const step = (hi - lo) / vpRows;
  if (!(step > 0)) return null;

  // spread each bar's volume across every row it spans
  const vols = new Array(vpRows).fill(0);
  for (const b of win) {
    const r1 = Math.max(0, Math.min(vpRows - 1, Math.floor((b.l - lo) / step)));
    const r2 = Math.max(0, Math.min(vpRows - 1, Math.floor((b.h - lo) / step)));
    const per = b.v / (r2 - r1 + 1);
    for (let r = r1; r <= r2; r++) vols[r] += per;
  }

  let pocIdx = 0, pocVol = 0;
  for (let r = 0; r < vpRows; r++) if (vols[r] > pocVol) { pocVol = vols[r]; pocIdx = r; }
  if (pocVol <= 0) return null;

  // value area: expand from POC, always taking the fatter neighbour
  const total = vols.reduce((a, b) => a + b, 0);
  const target = total * vaPct / 100;
  let up = pocIdx, dn = pocIdx, acc = pocVol;
  for (let k = 0; k < vpRows * 2 && acc < target; k++) {
    const vUp = up < vpRows - 1 ? vols[up + 1] : -1;
    const vDn = dn > 0 ? vols[dn - 1] : -1;
    if (vUp < 0 && vDn < 0) break;
    if (vUp >= vDn) { up++; acc += vUp; } else { dn--; acc += vDn; }
  }

  const level = r => lo + (r + 0.5) * step;
  const nodes = [];
  for (let r = 0; r < vpRows; r++) if (vols[r] >= pocVol * hvnThr) nodes.push(level(r));

  return {
    hi, lo, step, pocVol, total, nodes,
    poc: level(pocIdx), vah: lo + (up + 1) * step, val: lo + dn * step,
    rows: vols.map((v, r) => ({
      price: level(r), share: v / pocVol,
      inVA: r >= dn && r <= up, isHVN: v >= pocVol * hvnThr, isPOC: r === pocIdx
    }))
  };
}

// Next two volume shelves in the trade's direction, with the same fallback
// chain as the Pine script.
export function pickTargets(prof, entryP, dir, minGap, risk, fallbackRR = 2) {
  const rr = m => dir === 1 ? entryP + risk * m : entryP - risk * m;
  let n1 = null, n2 = null;

  if (prof) {
    if (dir === 1) {
      for (const lvl of prof.nodes) {                 // ascending → nearest first
        if (lvl - entryP < minGap) continue;
        if (n1 === null) n1 = lvl;
        else if (n2 === null && lvl - n1 >= minGap) { n2 = lvl; break; }
      }
    } else {
      // ascending too, carrying the nearest forward. Adjacent hot rows are one
      // shelf, not several targets.
      for (const lvl of prof.nodes) {
        if (entryP - lvl < minGap) continue;
        if (n1 === null) n1 = lvl;
        else { if (lvl - n1 >= minGap) n2 = n1; n1 = lvl; }
      }
    }
  }

  const vaEdge = prof ? (dir === 1 ? prof.vah : prof.val) : null;
  const vaOk = vaEdge !== null && (dir === 1 ? vaEdge - entryP >= minGap : entryP - vaEdge >= minGap);

  let out;
  if (n1 !== null && n2 !== null) out = { tp1: n1, tp2: n2, source: 'HVN → HVN' };
  else if (n1 !== null && vaOk && (dir === 1 ? vaEdge > n1 : vaEdge < n1))
    out = { tp1: n1, tp2: vaEdge, source: `HVN → ${dir === 1 ? 'VAH' : 'VAL'}` };
  else if (n1 !== null) out = { tp1: n1, tp2: rr(fallbackRR), source: `HVN → ${fallbackRR}R` };
  else if (vaOk) {
    const edge = dir === 1 ? Math.max(prof.hi, rr(fallbackRR)) : Math.min(prof.lo, rr(fallbackRR));
    out = { tp1: vaEdge, tp2: edge, source: `${dir === 1 ? 'VAH' : 'VAL'} → range edge` };
  }
  else out = { tp1: rr(1), tp2: rr(fallbackRR), source: `breakout · ${fallbackRR}R` };

  // A distant shelf can sit beyond the R fallback, which would leave TP2 nearer
  // than TP1. The nearer level is always TP1 — swap rather than emit garbage.
  const ordered = dir === 1 ? out.tp2 > out.tp1 : out.tp2 < out.tp1;
  if (!ordered) {
    const [a, b] = out.source.split(' → ');
    out = { tp1: out.tp2, tp2: out.tp1, source: (a && b) ? `${b} → ${a}` : out.source };
  }
  return out;
}

// Is this bar rejecting off a shelf? A reversal candle in thin air is noise;
// the same candle on a volume node is a level being defended.
export function atNode(prof, price, tol) {
  if (!prof) return false;
  for (const lvl of prof.nodes) if (Math.abs(price - lvl) <= tol) return true;
  return false;
}
