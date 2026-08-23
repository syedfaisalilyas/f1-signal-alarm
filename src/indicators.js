// Pine-faithful indicator math. All functions return full series (same length as input,
// with `null` where undefined) so the strategy can walk bars exactly like Pine does.

export function ema(values, len) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null, sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      sum += v;
      if (i === len - 1) { prev = sum / len; out[i] = prev; }   // seed = SMA, like Pine
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

// Wilder smoothing (ta.rma) — used by RSI and ATR
export function rma(values, len) {
  const out = new Array(values.length).fill(null);
  let prev = null, sum = 0, count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    if (prev === null) {
      sum += v; count++;
      if (count === len) { prev = sum / len; out[i] = prev; }
    } else {
      prev = (prev * (len - 1) + v) / len;
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(closes, len) {
  const gains = new Array(closes.length).fill(null);
  const losses = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains[i] = Math.max(ch, 0);
    losses[i] = Math.max(-ch, 0);
  }
  const ag = rma(gains, len), al = rma(losses, len);
  return closes.map((_, i) => {
    if (ag[i] === null || al[i] === null) return null;
    if (al[i] === 0) return 100;
    const rs = ag[i] / al[i];
    return 100 - 100 / (1 + rs);
  });
}

export function macd(closes, fast, slow, signal) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] === null || es[i] === null) ? null : ef[i] - es[i]);
  const compact = line.filter(v => v !== null);
  const sigCompact = ema(compact, signal);
  const sig = new Array(line.length).fill(null);
  let j = 0;
  for (let i = 0; i < line.length; i++) if (line[i] !== null) sig[i] = sigCompact[j++];
  const hist = line.map((v, i) => (v === null || sig[i] === null) ? null : v - sig[i]);
  return { line, signal: sig, hist };
}

export function atr(highs, lows, closes, len) {
  const tr = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    tr[i] = i === 0 ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  return rma(tr, len);
}

export function lowest(values, len, i) {
  let m = Infinity;
  for (let k = Math.max(0, i - len + 1); k <= i; k++) m = Math.min(m, values[k]);
  return m;
}

export function highest(values, len, i) {
  let m = -Infinity;
  for (let k = Math.max(0, i - len + 1); k <= i; k++) m = Math.max(m, values[k]);
  return m;
}

// ── Single-step EMA projection: what the EMA becomes if this bar closes at `price` ──
export function emaNext(prevEma, price, len) {
  const k = 2 / (len + 1);
  return price * k + prevEma * (1 - k);
}

// Exact price at which emaFast crosses emaSlow on the CURRENT forming bar.
// Solve: x*kF + F*(1-kF) = x*kS + S*(1-kS)
export function crossPrice(prevFast, prevSlow, fastLen, slowLen) {
  const kF = 2 / (fastLen + 1), kS = 2 / (slowLen + 1);
  const denom = kF - kS;
  if (Math.abs(denom) < 1e-12) return null;
  return (prevSlow * (1 - kS) - prevFast * (1 - kF)) / denom;
}

// ── ADX / DI (Wilder) — trend strength, to tell a run from a chop ──
export function adx(highs, lows, closes, len) {
  const n = closes.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    plusDM[i] = (up > dn && up > 0) ? up : 0;
    minusDM[i] = (dn > up && dn > 0) ? dn : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const atrS = rma(tr.slice(1), len), pS = rma(plusDM.slice(1), len), mS = rma(minusDM.slice(1), len);
  const pDI = new Array(n).fill(null), mDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const a = atrS[i - 1], p = pS[i - 1], m = mS[i - 1];
    if (a === null || p === null || m === null || a === 0) continue;
    pDI[i] = 100 * p / a;
    mDI[i] = 100 * m / a;
    const sum = pDI[i] + mDI[i];
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pDI[i] - mDI[i]) / sum;
  }
  const compact = dx.filter(v => v !== null);
  const sm = rma(compact, len);
  const out = new Array(n).fill(null);
  let j = 0;
  for (let i = 0; i < n; i++) if (dx[i] !== null) out[i] = sm[j++];
  return { adx: out, plusDI: pDI, minusDI: mDI };
}
