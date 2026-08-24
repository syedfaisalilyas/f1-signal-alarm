// Empirical stop/target sizing.
//
// Instead of picking an R multiple, look at what price actually did after every
// historical signal: how far it went against the entry before working (MAE), and
// how far it ran when it did (MFE). Put the stop just beyond where winners
// normally pull back to, and size targets from how far winners actually travel.
// Everything is measured in ATR so it transfers across symbols and volatility.

import { ema, sma, rsi, macd, atr } from './indicators.js';

export function calibrate(candles, cfg = {}) {
  const c = {
    emaFast: 9, emaSlow: 21, rsiLen: 14, rsiOB: 70, rsiOS: 30,
    macdFast: 12, macdSlow: 26, macdSignal: 9, atrLen: 14,
    horizon: 60,        // bars to follow each signal
    workedAtr: 2.0,     // a signal "worked" if it ran this far in ATR
    coverage: 0.85,     // stop must sit beyond this share of winners' pullbacks
    ...cfg
  };
  const n = candles.length;
  const high = candles.map(x => x.h), low = candles.map(x => x.l), close = candles.map(x => x.c);
  const eF = ema(close, c.emaFast), eS = ema(close, c.emaSlow);
  const r = rsi(close, c.rsiLen);
  const m = macd(close, c.macdFast, c.macdSlow, c.macdSignal);
  const a = atr(high, low, close, c.atrLen);

  const ready = i => eF[i] !== null && eS[i] !== null && r[i] !== null && m.signal[i] !== null && a[i] !== null && a[i] > 0;

  const samples = [];
  for (let i = 1; i < n - 5; i++) {
    if (!ready(i) || !ready(i - 1)) continue;
    const up = eF[i - 1] <= eS[i - 1] && eF[i] > eS[i];
    const dn = eF[i - 1] >= eS[i - 1] && eF[i] < eS[i];
    const isLong = up && r[i] > c.rsiOS && m.line[i] > m.signal[i];
    const isShort = dn && r[i] < c.rsiOB && m.line[i] < m.signal[i];
    if (!isLong && !isShort) continue;

    const dir = isLong ? 1 : -1;
    const entry = close[i], unit = a[i];
    let mae = 0, mfe = 0, maeBeforeWin = 0, worked = false, barsToWork = null;

    for (let k = i + 1; k < Math.min(n, i + 1 + c.horizon); k++) {
      const adverse = dir === 1 ? (entry - low[k]) / unit : (high[k] - entry) / unit;
      const favor = dir === 1 ? (high[k] - entry) / unit : (entry - low[k]) / unit;
      if (adverse > mae) mae = adverse;
      if (favor > mfe) mfe = favor;
      if (!worked) {
        maeBeforeWin = mae;
        if (favor >= c.workedAtr) { worked = true; barsToWork = k - i; }
      }
    }
    samples.push({ bar: i, dir, mae, mfe, maeBeforeWin, worked, barsToWork });
  }

  if (samples.length < 8) return null;

  const q = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  const winners = samples.filter(s => s.worked);
  const maeWin = winners.map(s => s.maeBeforeWin);
  const mfeAll = samples.map(s => s.mfe);
  const mfeWin = winners.map(s => s.mfe);

  // The stop: just past where winners normally pull back to.
  const stopAtr = maeWin.length ? +(q(maeWin, c.coverage) * 1.15 + 0.15).toFixed(2) : null;

  return {
    signals: samples.length,
    worked: winners.length,
    workRate: winners.length / samples.length * 100,
    maeWinP50: q(maeWin, 0.5), maeWinP80: q(maeWin, 0.8), maeWinP95: q(maeWin, 0.95),
    mfeP50: q(mfeAll, 0.5), mfeP75: q(mfeAll, 0.75), mfeP90: q(mfeAll, 0.9),
    mfeWinP50: q(mfeWin, 0.5), mfeWinP90: q(mfeWin, 0.9),
    medianBarsToWork: q(winners.map(s => s.barsToWork).filter(Boolean), 0.5),
    stopAtr,
    // Expected R if the stop sits at stopAtr and a winner runs to its median MFE
    impliedR: stopAtr ? +(q(mfeWin, 0.5) / stopAtr).toFixed(2) : null
  };
}
