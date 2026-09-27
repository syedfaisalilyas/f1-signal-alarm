// Daily trade setups for the Calls page — the only ones that held up in tools/lab/htf.mjs
// (Jan 2022 → Sep 2026, fees + funding in, pick → check → exam split). The bt
// numbers are this file's own rules replayed bar by bar over that span on gold
// and the top 50 Binance perps, one open call per market per setup.
// Everything runs on closed 4H bars; daily bars are rolled up from them at
// UTC midnight, so a daily setup can only fire on the 20:00–24:00 UTC bar.
//
//   gold-dbreak   gold daily close above the 20-day high        stop 2 daily ATR, 2R, 30 days
//   gold-dflip    gold daily uptrend switches on                 stop 2 daily ATR, 2R, 30 days
//   gold-pb4      gold 4H pullback to EMA20 in a daily uptrend   stop past the 3-bar swing (1–3 4H ATR), 2R, 10 days
//   crypto-dbreak coin daily close above the 20-day high         stop 2 daily ATR, trailing, 30 days
//
// Crypto trail: stop to entry once +1R, then out on the first 4H close back
// under the 4H EMA20. Shorts, forex and every 5m/15m setup tested flat or
// negative after fees, so they are not called.

export const SETUPS = {
  'gold-dbreak': { name: 'Daily 20-day breakout', tf: 'Daily', exit: '2R', maxBars: 180, verdict: 'TAKE', hot: true,
    bt: { n: 43, win: 56, avg: 0.63, years: '4/5', last12: 0.74 } },
  'gold-dflip': { name: 'Daily uptrend starts', tf: 'Daily', exit: '2R', maxBars: 180, verdict: 'TAKE', hot: true,
    bt: { n: 24, win: 54, avg: 0.45, years: '4/5', last12: 0.88 } },
  'gold-pb4': { name: '4H pullback in the daily uptrend', tf: '4H', exit: '2R', maxBars: 60, verdict: 'TAKE', hot: false,
    bt: { n: 116, win: 49, avg: 0.38, years: '5/5', last12: 0.38 } },
  'crypto-dbreak': { name: 'Daily 20-day breakout, BTC in a daily uptrend', tf: 'Daily', exit: 'trail', maxBars: 180, verdict: 'TAKE', hot: true,
    bt: { n: 787, win: 47, avg: 0.29, years: '4/5', last12: 0.44 } },
  'crypto-dbreak-nobtc': { name: 'Daily 20-day breakout, BTC not in an uptrend', tf: 'Daily', exit: 'trail', maxBars: 180, verdict: 'SKIP', hot: false,
    bt: { n: 468, win: 44, avg: 0.08, years: '4/5', last12: 0.00 } }
};
export const RR = 2;
export const BACKTEST = {
  span: 'Jan 2022 → Sep 2026', tested: '166,843 5m/15m setups and 12,072 daily/4H ones', note:
    'On 5m and 15m every concept (S/R, Fibonacci, sweeps, order flow, RSI, breakouts, trend pullbacks) was a coin flip before fees and lost after them, and stacking confluences did not help. ' +
    'Only daily setups held up: gold longs at 1:2 and crypto breakout longs with a trailing stop. Shorts and forex had no edge.'
};

const ema = (a, n) => { const k = 2 / (n + 1), out = []; a.forEach((v, i) => out.push(i ? v * k + out[i - 1] * (1 - k) : v)); return out; };
// Wilder ATR over a whole series
function atrS(b, n = 14) {
  const out = []; let a = null;
  for (let i = 0; i < b.length; i++) {
    const tr = i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
    a = a == null ? tr : (a * (n - 1) + tr) / n; out.push(a);
  }
  return out;
}
function days(b4) {
  const out = [];
  for (const x of b4) {
    const t = x.t - x.t % 86400, last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, x.h); last.l = Math.min(last.l, x.l); last.c = x.c; }
    else out.push({ t, o: x.o, h: x.h, l: x.l, c: x.c });
  }
  return out;
}
const trendAt = (c, e20, e50, j) => j < 55 ? 0 : e20[j] > e50[j] && c[j] > e50[j] && e20[j] > e20[j - 3] ? 1 : e20[j] < e50[j] && c[j] < e50[j] && e20[j] < e20[j - 3] ? -1 : 0;

// Daily trend of a 4H series as of its last closed day (used for BTC).
export function dailyTrend(b4) {
  const d = days(b4), lastClosed = (b4.at(-1).t + 14400) % 86400 === 0 ? d.length - 1 : d.length - 2;
  const c = d.map(x => x.c);
  return trendAt(c, ema(c, 20), ema(c, 50), lastClosed);
}

// What the last closed 4H bar says. b4 = closed 4H bars, oldest first.
// Returns { status, side, setup?, entry, sl, tp, barT, trigger, blockers, trend }.
export function analyse(cls, b4, btcUp) {
  const i = b4.length - 1, x = b4[i];
  const d = days(b4), dayClose = (x.t + 14400) % 86400 === 0;
  const j = dayClose ? d.length - 1 : d.length - 2;             // last closed day
  const base = { status: 'none', side: 0, blockers: [], barT: x.t, price: x.c, trend: 0 };
  if (j < 60 || i < 60) return { ...base, blockers: ['not enough history'] };
  const dc = d.map(y => y.c), de20 = ema(dc, 20), de50 = ema(dc, 50), dA = atrS(d);
  const dt = trendAt(dc, de20, de50, j);
  const hi20 = Math.max(...d.slice(j - 20, j).map(y => y.h));
  const c4 = b4.map(y => y.c), e20 = ema(c4, 20), A4 = atrS(b4);
  const out = { ...base, trend: dt, trigger: hi20, atrD: dA[j] };

  const make = (setup, stop) => {
    const s = SETUPS[setup], dist = x.c - stop;
    return { ...out, status: 'ready', side: 1, setup, entry: x.c, sl: stop, tp: s.exit === '2R' ? x.c + RR * dist : null, maxBars: s.maxBars };
  };
  if (cls === 'gold') {
    if (dayClose && dc[j] > hi20) return make('gold-dbreak', x.c - 2 * dA[j]);
    if (dayClose && dt === 1 && trendAt(dc, de20, de50, j - 1) !== 1) return make('gold-dflip', x.c - 2 * dA[j]);
    if (dt === 1) {
      const touched = b4.slice(i - 2).some(y => y.l <= e20[i] + 0.3 * A4[i]);
      const rng = x.h - x.l || 1e-12, body = x.c - x.o;
      if (touched && body > 0 && body / rng >= 0.5 && x.c > b4[i - 1].h && x.c > e20[i]) {
        const swing = Math.min(...b4.slice(i - 2).map(y => y.l)) - 0.2 * A4[i];
        const dist = Math.min(Math.max(x.c - swing, A4[i]), 3 * A4[i]);
        return make('gold-pb4', x.c - dist);
      }
    }
  }
  if (cls === 'crypto' && dayClose && dc[j] > hi20) return make(btcUp ? 'crypto-dbreak' : 'crypto-dbreak-nobtc', x.c - 2 * dA[j]);

  // not ready: how close is it?
  const away = (hi20 - x.c) / dA[j];
  if (dt === 1 && away <= 1) return { ...out, status: 'watching', side: 1, blockers: [`${away <= 0 ? 'above' : away.toFixed(1) + ' daily ATR below'} the 20-day high — a daily close above it fires the call`] };
  if (dt === 1) return { ...out, status: 'trend', side: 1, blockers: [cls === 'gold' ? 'Daily uptrend — waiting for a 4H pullback to EMA20 or a 20-day breakout' : `Daily uptrend — ${away.toFixed(1)} daily ATR below the 20-day high`] };
  return { ...out, blockers: [dt < 0 ? 'Daily downtrend — shorts are not called (no edge)' : 'No daily trend'] };
}

// Walk the 4H bars after entry. Same rules as the backtest: SL and TP in one
// bar = SL; the crypto trail moves the stop to entry at +1R and exits on a 4H
// close under EMA20 after that. Returns null while still open (and updates
// call.mfe / call.stopNow for the page).
export function settle(call, b4) {
  const e20 = ema(b4.map(y => y.c), 20);
  const risk = call.entry - call.sl;
  let stop = call.sl, mfe = 0, n = 0;
  const out = (status, r, t) => ({ status, r: Math.round(r * 100) / 100, closedAt: t * 1000, mfe: +mfe.toFixed(2), bars: n });
  for (let k = 0; k < b4.length; k++) {
    const b = b4[k];
    if (b.t <= call.barT) continue;
    n++;
    if (b.l <= stop) return out(stop >= call.entry ? 'be' : 'sl', (stop - call.entry) / risk, b.t + 14400);
    mfe = Math.max(mfe, (b.h - call.entry) / risk);
    if (call.tp != null) {
      if (b.h >= call.tp) return out('tp', (call.tp - call.entry) / risk, b.t + 14400);
    } else if (mfe >= 1) {
      stop = Math.max(stop, call.entry);
      if (b.c < e20[k]) return out('trail', (b.c - call.entry) / risk, b.t + 14400);
    }
    if (n >= call.maxBars) return out('expired', (b.c - call.entry) / risk, b.t + 14400);
  }
  call.mfe = +mfe.toFixed(2);
  call.stopNow = stop;
  return null;
}
