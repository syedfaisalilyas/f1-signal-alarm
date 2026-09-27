// Sona's method as rules, for sonabot. Pure functions on candles, so the
// backtest and the live bot run the same code.
//
// Zones: on 4H candles over the last 60 days, find swing lows (demand) and
// swing highs (supply) that price bounced hard from (≥ REACT_ATR ATR within
// 3 days). Swings within CLUSTER_ATR of each other are one zone; a zone needs
// ≥ 2 touches and no 4H close through it since its last touch.
// Setup (long): the nearest valid demand zone below price, not further than
// MAX_AWAY_ATR: entry 1 = zone top, entry 2 = zone bottom, SL = 30m close below
// bottom − SL_PAD_ATR. TP1 = +1R from entry 1 (half book, SL to entry — her
// rule), final TP = the next supply zone above, at least MIN_RR from the
// planned average and 1.5R from entry 1. Shorts mirror this.
// BTC leads: longs only while BTC's daily close is in the top half of its
// 20-day range, shorts only in the bottom half.
// Her coins — the ones she traded all year, plus ONDO, WLD and AVAX (her Sep 2026 trades).
export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'SUI', 'LINK', 'AAVE', 'ADA', 'DOGE', 'TAO', 'LTC', 'DOT', 'UNI', 'ONDO', 'WLD', 'AVAX'];

export const CFG = {
  LOOKBACK: 360, PIV: 4, REACT_ATR: 1.5, REACT_BARS: 18, CLUSTER_ATR: 0.6, MIN_WIDTH_ATR: 0.3,
  MIN_TOUCH: 2, MAX_AWAY_ATR: 2.5, SL_PAD_ATR: 0.3, MIN_RR: 2, MAX_RR: 5, SIDES: 'LS'
};

export function atr(k, n = 14) {
  const out = new Array(k.length).fill(null);
  let a = null;
  for (let i = 1; i < k.length; i++) {
    const tr = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c));
    a = a == null ? tr : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

// k: 4H candles oldest first, all closed. Returns { demand: [...], supply: [...] }.
export function findZones(k, cfg = CFG) {
  const n = k.length, A = atr(k), a = A[n - 1];
  if (!a) return { demand: [], supply: [], atr: null };
  const from = Math.max(cfg.PIV, n - cfg.LOOKBACK);
  const lows = [], highs = [];
  for (let i = from; i < n - cfg.PIV; i++) {
    let isL = true, isH = true;
    for (let j = i - cfg.PIV; j <= i + cfg.PIV; j++) {
      if (j === i) continue;
      if (k[j].l < k[i].l) isL = false;
      if (k[j].h > k[i].h) isH = false;
    }
    const end = Math.min(n - 1, i + cfg.REACT_BARS);
    // react = how far price moved away from the swing within REACT_BARS (the bounce)
    if (isL) { let mx = -Infinity; for (let j = i + 1; j <= end; j++) mx = Math.max(mx, k[j].h); if (mx - k[i].l >= cfg.REACT_ATR * a) lows.push({ i, t: k[i].t, v: k[i].l, react: (mx - k[i].l) / k[i].l }); }
    if (isH) { let mn = Infinity; for (let j = i + 1; j <= end; j++) mn = Math.min(mn, k[j].l); if (k[i].h - mn >= cfg.REACT_ATR * a) highs.push({ i, t: k[i].t, v: k[i].h, react: (k[i].h - mn) / k[i].h }); }
  }
  const cluster = (pts, kind) => {
    const s = [...pts].sort((x, y) => x.v - y.v), zones = [];
    for (const p of s) {
      const z = zones.at(-1);
      if (z && p.v - z.lo <= cfg.CLUSTER_ATR * a) { z.hi = Math.max(z.hi, p.v); z.touch++; z.last = Math.max(z.last, p.i); z.pts.push(p); }
      else zones.push({ lo: p.v, hi: p.v, touch: 1, last: p.i, kind, pts: [p] });
    }
    for (const z of zones) {
      if (z.hi - z.lo < cfg.MIN_WIDTH_ATR * a) { if (kind === 'D') z.hi = z.lo + cfg.MIN_WIDTH_ATR * a; else z.lo = z.hi - cfg.MIN_WIDTH_ATR * a; }
      // broken = a 4H close through it after its last touch
      z.broken = false;
      for (let j = z.last + 1; j < n; j++) if (kind === 'D' ? k[j].c < z.lo : k[j].c > z.hi) { z.broken = true; break; }
    }
    return zones.filter(z => z.touch >= cfg.MIN_TOUCH && !z.broken);
  };
  return { demand: cluster(lows, 'D'), supply: cluster(highs, 'S'), atr: a };
}

// BTC regime from daily candles (closed): +1 longs allowed, -1 shorts allowed.
export function btcRegime(d) {
  const last = d.slice(-20);
  if (last.length < 20) return 0;
  const hi = Math.max(...last.map(x => x.h)), lo = Math.min(...last.map(x => x.l));
  return last.at(-1).c >= (hi + lo) / 2 ? 1 : -1;
}

// Returns a setup { side, e1, e2, sl, tps } or null.
export function setup(k4, px, regime, cfg = CFG) {
  const { demand, supply, atr: a } = findZones(k4, cfg);
  if (!a || !(px > 0)) return null;
  const out = [];
  if (regime > 0 && cfg.SIDES.includes('L')) {
    const z = demand.filter(z => z.hi < px && px - z.hi <= cfg.MAX_AWAY_ATR * a).sort((x, y) => y.hi - x.hi)[0];
    if (z) {
      const e1 = z.hi, e2 = z.lo, sl = z.lo - cfg.SL_PAD_ATR * a, avg = (e1 + e2) / 2, R = avg - sl;
      const nxt = supply.filter(s => s.lo > e1).sort((x, y) => x.lo - y.lo)[0];
      const tgt = Math.min(Math.max(nxt ? nxt.lo : avg + cfg.MIN_RR * R, avg + cfg.MIN_RR * R), avg + cfg.MAX_RR * R);
      out.push({ side: 'L', e1, e2, sl, tps: [e1 + (e1 - sl), Math.max(tgt, e1 + (e1 - sl) * 1.5)], zone: z, next: nxt || null, atr: a });
    }
  }
  if (regime < 0 && cfg.SIDES.includes('S')) {
    const z = supply.filter(z => z.lo > px && z.lo - px <= cfg.MAX_AWAY_ATR * a).sort((x, y) => x.lo - y.lo)[0];
    if (z) {
      const e1 = z.lo, e2 = z.hi, sl = z.hi + cfg.SL_PAD_ATR * a, avg = (e1 + e2) / 2, R = sl - avg;
      const nxt = demand.filter(d => d.hi < e1).sort((x, y) => y.hi - x.hi)[0];
      const tgt = Math.max(Math.min(nxt ? nxt.hi : avg - cfg.MIN_RR * R, avg - cfg.MIN_RR * R), avg - cfg.MAX_RR * R);
      out.push({ side: 'S', e1, e2, sl, tps: [e1 - (sl - e1), Math.min(tgt, e1 - (sl - e1) * 1.5)], zone: z, next: nxt || null, atr: a });
    }
  }
  return out[0] || null;
}
