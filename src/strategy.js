// F1 Scalper Pro — JS port of the Pine v5 script.
// Walks every bar exactly like Pine so state/TP/SL match the chart.

import { ema, sma, rsi, macd, atr, lowest, highest, emaNext, crossPrice } from './indicators.js';
import { VP_DEFAULTS, buildProfile, pickTargets, atNode } from './volumeprofile.js';

export const DEFAULTS = {
  emaFast: 9, emaSlow: 21,
  rsiLen: 14, rsiOB: 70, rsiOS: 30,
  macdFast: 12, macdSlow: 26, macdSignal: 9,
  volLen: 20, volMult: 1.5,
  requireVol: false, useTrend: false, trendLen: 200,
  useAtrFilter: false, minAtrPct: 0.10, rsiTwoSided: false, cooldown: 0,
  atrLen: 14, slMode: 'Swing', slLookback: 3, slAtrMult: 1.2,
  slBuf: 0.25, minRiskAtr: 0.35, rr1: 1.0, rr2: 2.0,
  useRevExit: true, revOnlyInProfit: true, beAfterTp1: true, maxBars: 40,
  tp1Portion: 0.5,          // fraction of the position banked at TP1
  beAtR: 1.0,               // move the stop to entry once the trade reaches this R
  useTrail: true,           // trail the stop behind the running high/low
  trailAfterR: 1.5,         // start trailing once this R is reached
  trailAtr: 2.5,            // trail distance, in ATR
  preAlertPct: 0.35,        // warn when price is this % from the trigger
  preAlertBars: 3,          // ...or when the cross is this many bars away
  ...VP_DEFAULTS            // tpMode, vpLen, vpRows, vaPct, hvnThr, minTpAtr, fallbackRR
};

export function analyze(candles, userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const n = candles.length;
  if (n < Math.max(cfg.emaSlow, cfg.macdSlow, cfg.rsiLen, cfg.atrLen) + 30) return null;

  const open = candles.map(c => c.o), high = candles.map(c => c.h);
  const low = candles.map(c => c.l), close = candles.map(c => c.c), vol = candles.map(c => c.v);

  const eF = ema(close, cfg.emaFast), eS = ema(close, cfg.emaSlow), eT = ema(close, cfg.trendLen);
  const r = rsi(close, cfg.rsiLen);
  const m = macd(close, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const a = atr(high, low, close, cfg.atrLen);
  const vMa = sma(vol, cfg.volLen);

  const ready = i => eF[i] !== null && eS[i] !== null && r[i] !== null && m.signal[i] !== null && a[i] !== null && vMa[i] !== null;

  // ── per-bar condition helpers (mirrors the Pine booleans) ──
  const crossUp = i => i > 0 && ready(i) && ready(i - 1) && eF[i - 1] <= eS[i - 1] && eF[i] > eS[i];
  const crossDn = i => i > 0 && ready(i) && ready(i - 1) && eF[i - 1] >= eS[i - 1] && eF[i] < eS[i];
  const macdBull = i => m.line[i] > m.signal[i];
  const macdBear = i => m.line[i] < m.signal[i];
  const volSpike = i => vol[i] > vMa[i] * cfg.volMult;
  const atrPct = i => (a[i] / close[i]) * 100;

  const longBase = i => crossUp(i) && r[i] > cfg.rsiOS && macdBull(i);
  const shortBase = i => crossDn(i) && r[i] < cfg.rsiOB && macdBear(i);

  const trendOkL = i => !cfg.useTrend || (eT[i] !== null && close[i] > eT[i]);
  const trendOkS = i => !cfg.useTrend || (eT[i] !== null && close[i] < eT[i]);
  const atrOk = i => !cfg.useAtrFilter || atrPct(i) >= cfg.minAtrPct;
  const volOk = i => !cfg.requireVol || volSpike(i);
  const rsiOkL = i => !cfg.rsiTwoSided || r[i] < cfg.rsiOB;
  const rsiOkS = i => !cfg.rsiTwoSided || r[i] > cfg.rsiOS;

  const longSig = i => longBase(i) && rsiOkL(i) && trendOkL(i) && atrOk(i) && volOk(i);
  const shortSig = i => shortBase(i) && rsiOkS(i) && trendOkS(i) && atrOk(i) && volOk(i);

  // ── reversal candles ──
  const body = i => Math.abs(close[i] - open[i]);
  const upW = i => high[i] - Math.max(close[i], open[i]);
  const loW = i => Math.min(close[i], open[i]) - low[i];
  const hammer = i => loW(i) >= body(i) * 2 && upW(i) <= body(i) && close[i] > open[i];
  const star = i => upW(i) >= body(i) * 2 && loW(i) <= body(i) && close[i] < open[i];
  const bullEng = i => i > 0 && close[i] > open[i] && close[i - 1] < open[i - 1] && close[i] > open[i - 1] && open[i] < close[i - 1];
  const bearEng = i => i > 0 && close[i] < open[i] && close[i - 1] > open[i - 1] && close[i] < open[i - 1] && open[i] > close[i - 1];
  const macdXdn = i => i > 0 && m.line[i - 1] >= m.signal[i - 1] && m.line[i] < m.signal[i];
  const macdXup = i => i > 0 && m.line[i - 1] <= m.signal[i - 1] && m.line[i] > m.signal[i];
  const bearRev = i => star(i) || bearEng(i) || macdXdn(i) || (r[i] > cfg.rsiOB && close[i] < open[i]) || crossDn(i);
  const bullRev = i => hammer(i) || bullEng(i) || macdXup(i) || (r[i] < cfg.rsiOS && close[i] > open[i]) || crossUp(i);

  // Name the stop for what it actually was, so the history reads at a glance.
  const stopLabel = (tp1, be, sl, entry) => {
    const beyondEntry = pos === 1 ? sl > entry : sl < entry;
    if (beyondEntry) return tp1 ? 'TP1 HIT → TRAIL' : 'TRAIL STOP';
    if (sl === entry) return tp1 ? 'TP1 HIT → BE' : 'BE STOP';
    return tp1 ? 'TP1 HIT → SL' : 'SL HIT';
  };

  // A momentum flip (EMA/MACD cross) always counts. A lone candle pattern only
  // counts when it lands on a volume shelf — otherwise it's noise.
  const momentumFlip = (i, dir) => dir === 1 ? (macdXdn(i) || crossDn(i)) : (macdXup(i) || crossUp(i));
  const onShelf = (i, dir) => atNode(entryProf, dir === 1 ? high[i] : low[i], a[i] * 0.6);
  const revConfirmed = (i, dir) =>
    cfg.tpMode !== 'profile' || momentumFlip(i, dir) || onShelf(i, dir);
  const revTag = (i, dir) =>
    (cfg.tpMode === 'profile' && !momentumFlip(i, dir) && onShelf(i, dir)) ? 'TP REVERSAL @ NODE' : 'TP REVERSAL';

  // ── state machine over closed bars ──
  const lastClosed = candles[n - 1].closed ? n - 1 : n - 2;
  let pos = 0, entryP = null, slP = null, slInit = null, tp1P = null, tp2P = null;
  let entryBar = null, tp1Done = false, lastExit = -9999;
  let entryProf = null;
  let mfePx = null, beDone = false, tp2Hit = false;
  const trades = [];
  let openTrade = null;

  for (let i = 0; i <= lastClosed; i++) {
    if (!ready(i)) continue;
    let exitPx = null, exitTag = '', flip = false;

    if (pos === 1) {
      if (low[i] <= slP) { exitPx = Math.min(slP, open[i]); exitTag = stopLabel(tp1Done, beDone, slP, entryP); }
      else if (high[i] >= tp2P) { exitPx = tp2P; tp2Hit = true; exitTag = 'TP2 HIT'; }
      else {
        if (!tp1Done && high[i] >= tp1P) { tp1Done = true; if (cfg.beAfterTp1) slP = entryP; }

        // Ratchet the stop using this bar's extreme, but only AFTER the stop has
        // been tested above — otherwise a bar's high would protect against its
        // own low. A trade that ran to +1R and came back should not book -1R.
        mfePx = Math.max(mfePx, high[i]);
        const mfeR = (mfePx - entryP) / (entryP - slInit);
        if (!beDone && mfeR >= cfg.beAtR) { slP = Math.max(slP, entryP); beDone = true; }
        if (cfg.useTrail && mfeR >= cfg.trailAfterR) slP = Math.max(slP, mfePx - a[i] * cfg.trailAtr);

        if (i > entryBar) {
          if (cfg.useRevExit && bearRev(i) && revConfirmed(i, 1) && (!cfg.revOnlyInProfit || close[i] > entryP)) { exitPx = close[i]; exitTag = revTag(i, 1); flip = shortSig(i); }
          else if (shortSig(i)) { exitPx = close[i]; exitTag = 'FLIP'; flip = true; }
          else if (cfg.maxBars > 0 && i - entryBar >= cfg.maxBars) { exitPx = close[i]; exitTag = 'TIME'; }
        }
      }
    } else if (pos === -1) {
      if (high[i] >= slP) { exitPx = Math.max(slP, open[i]); exitTag = stopLabel(tp1Done, beDone, slP, entryP); }
      else if (low[i] <= tp2P) { exitPx = tp2P; tp2Hit = true; exitTag = 'TP2 HIT'; }
      else {
        if (!tp1Done && low[i] <= tp1P) { tp1Done = true; if (cfg.beAfterTp1) slP = entryP; }

        mfePx = Math.min(mfePx, low[i]);
        const mfeR = (entryP - mfePx) / (slInit - entryP);
        if (!beDone && mfeR >= cfg.beAtR) { slP = Math.min(slP, entryP); beDone = true; }
        if (cfg.useTrail && mfeR >= cfg.trailAfterR) slP = Math.min(slP, mfePx + a[i] * cfg.trailAtr);

        if (i > entryBar) {
          if (cfg.useRevExit && bullRev(i) && revConfirmed(i, -1) && (!cfg.revOnlyInProfit || close[i] < entryP)) { exitPx = close[i]; exitTag = revTag(i, -1); flip = longSig(i); }
          else if (longSig(i)) { exitPx = close[i]; exitTag = 'FLIP'; flip = true; }
          else if (cfg.maxBars > 0 && i - entryBar >= cfg.maxBars) { exitPx = close[i]; exitTag = 'TIME'; }
        }
      }
    }

    if (exitPx !== null) {
      const rAt = px => pos === 1 ? (px - entryP) / (entryP - slInit) : (entryP - px) / (slInit - entryP);
      const pctAt = px => ((pos === 1 ? px - entryP : entryP - px) / entryP) * 100;
      // TP1 takes a slice off the table, so only the remainder rides to the final
      // exit. Without this, a stop that trailed to breakeven after TP1 books 0R —
      // which reports a trade that actually banked profit as a scratch.
      const part = tp1Done ? Math.min(1, Math.max(0, cfg.tp1Portion)) : 0;
      const rMult = part * rAt(tp1P) + (1 - part) * rAt(exitPx);
      const pnlPct = part * pctAt(tp1P) + (1 - part) * pctAt(exitPx);
      const peakR = mfePx === null ? 0 : rAt(mfePx);
      trades.push({
        ...openTrade, exitBar: i, exitTime: candles[i].t, exitPrice: exitPx, reason: exitTag,
        r: rMult, pnlPct, tp1Filled: tp1Done, tp1Portion: part,
        tp1Hit: tp1Done, tp2Hit, peakR, peakPct: mfePx === null ? 0 : pctAt(mfePx),
        gaveBack: peakR - rMult,
        rFinalLeg: rAt(exitPx), pctFinalLeg: pctAt(exitPx)
      });
      pos = 0; tp1Done = false; beDone = false; tp2Hit = false; mfePx = null; lastExit = i; openTrade = null;
    }

    const canEnter = pos === 0 && (flip || i - lastExit >= cfg.cooldown);
    if (canEnter && (longSig(i) || shortSig(i))) {
      const dir = longSig(i) ? 1 : -1;
      let raw;
      if (dir === 1) {
        const base = cfg.slMode === 'Prev candle' ? low[i - 1] : cfg.slMode === 'Swing' ? lowest(low, cfg.slLookback, i) : close[i] - a[i] * cfg.slAtrMult;
        raw = cfg.slMode === 'ATR' ? base : Math.min(base, low[i]) - a[i] * cfg.slBuf;
      } else {
        const base = cfg.slMode === 'Prev candle' ? high[i - 1] : cfg.slMode === 'Swing' ? highest(high, cfg.slLookback, i) : close[i] + a[i] * cfg.slAtrMult;
        raw = cfg.slMode === 'ATR' ? base : Math.max(base, high[i]) + a[i] * cfg.slBuf;
      }
      entryP = close[i];
      const risk = Math.max(dir === 1 ? entryP - raw : raw - entryP, a[i] * cfg.minRiskAtr);
      slP = dir === 1 ? entryP - risk : entryP + risk;
      slInit = slP;

      // Targets off the volume profile: the next two shelves ahead of entry.
      // The profile is built once, at entry, and kept for the life of the trade —
      // levels you mark going in are the levels you trade against.
      let tpSource;
      if (cfg.tpMode === 'profile') {
        entryProf = buildProfile(candles, i, cfg);
        const t = pickTargets(entryProf, entryP, dir, a[i] * cfg.minTpAtr, risk, cfg.fallbackRR);
        tp1P = t.tp1; tp2P = t.tp2; tpSource = t.source;
      } else {
        entryProf = null;
        tp1P = dir === 1 ? entryP + risk * cfg.rr1 : entryP - risk * cfg.rr1;
        tp2P = dir === 1 ? entryP + risk * cfg.rr2 : entryP - risk * cfg.rr2;
        tpSource = `${cfg.rr1}R \u2192 ${cfg.rr2}R`;
      }

      pos = dir; entryBar = i; tp1Done = false; beDone = false; tp2Hit = false;
      mfePx = close[i];
      openTrade = {
        side: dir === 1 ? 'LONG' : 'SHORT', entryBar: i, entryTime: candles[i].t,
        entryPrice: entryP, sl: slP, tp1: tp1P, tp2: tp2P, tpSource,
        riskPct: (risk / entryP) * 100, volConfirmed: volSpike(i),
        tp1Pct: (Math.abs(tp1P - entryP) / entryP) * 100,
        tp2Pct: (Math.abs(tp2P - entryP) / entryP) * 100
      };
    }
  }

  const li = lastClosed;
  const px = close[n - 1];
  const livePart = pos !== 0 && tp1Done ? Math.min(1, Math.max(0, cfg.tp1Portion)) : 0;
  const liveRAt = p2 => pos === 1 ? (p2 - entryP) / (entryP - slInit) : (entryP - p2) / (slInit - entryP);
  const livePctAt = p2 => ((pos === 1 ? p2 - entryP : entryP - p2) / entryP) * 100;
  const position = pos !== 0 ? {
    ...openTrade, sl: slP, tp1: tp1P, tp2: tp2P, tp1Done, tp1Portion: livePart,
    barsHeld: li - entryBar,
    livePnlPct: livePart * livePctAt(tp1P) + (1 - livePart) * livePctAt(px),
    liveR: livePart * liveRAt(tp1P) + (1 - livePart) * liveRAt(px),
    peakR: mfePx === null ? 0 : liveRAt(mfePx),
    trailing: beDone
  } : null;

  const wins = trades.filter(t => t.r >= 0).length;
  const stats = {
    trades: trades.length, wins, losses: trades.length - wins,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    totalR: trades.reduce((s, t) => s + t.r, 0),
    avgR: trades.length ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0
  };

  const liveProf = cfg.tpMode === 'profile' ? buildProfile(candles, li, cfg) : null;

  return {
    price: px,
    profile: liveProf && {
      poc: liveProf.poc, vah: liveProf.vah, val: liveProf.val,
      hi: liveProf.hi, lo: liveProf.lo,
      nodes: liveProf.nodes,
      rows: liveProf.rows.map(x => ({ p: x.price, s: x.share, va: x.inVA, h: x.isHVN, poc: x.isPOC })),
      atNode: atNode(liveProf, px, a[li] * 0.6)
    },
    atr: a[li], atrPct: atrPct(li), rsi: r[li],
    emaFast: eF[li], emaSlow: eS[li], emaTrend: eT[li],
    macdLine: m.line[li], macdSignal: m.signal[li], macdHist: m.hist[li],
    volRatio: vol[n - 1] / vMa[li],
    position, trades, stats,
    lastClosedBar: li, lastClosedTime: candles[li].t,
    forecast: forecast({ cfg, candles, li, eF, eS, eT, r, m, a, vMa, close, pos })
  };
}

// ══════════════ PRE-ALERT: how close is the next signal? ══════════════
// Two answers: (1) the exact price that triggers it on THIS bar,
// (2) how many bars away the cross is if price just keeps drifting.
function forecast({ cfg, candles, li, eF, eS, eT, r, m, a, vMa, close, pos }) {
  const price = close[close.length - 1];
  const pf = eF[li], ps = eS[li];
  if (pf === null || ps === null) return null;

  const side = pf <= ps ? 'LONG' : 'SHORT';   // a cross can only go the way the gap is
  const trigger = crossPrice(pf, ps, cfg.emaFast, cfg.emaSlow);
  if (trigger === null || !isFinite(trigger)) return null;

  const distPct = ((trigger - price) / price) * 100;

  // Would the non-EMA gates allow it right now?
  const conditions = {
    ema: true,
    rsi: side === 'LONG'
      ? r[li] > cfg.rsiOS && (!cfg.rsiTwoSided || r[li] < cfg.rsiOB)
      : r[li] < cfg.rsiOB && (!cfg.rsiTwoSided || r[li] > cfg.rsiOS),
    macd: side === 'LONG' ? m.line[li] > m.signal[li] : m.line[li] < m.signal[li],
    volume: !cfg.requireVol || (candles[candles.length - 1].v > vMa[li] * cfg.volMult),
    trend: !cfg.useTrend || (eT[li] !== null && (side === 'LONG' ? price > eT[li] : price < eT[li])),
    atr: !cfg.useAtrFilter || (a[li] / price) * 100 >= cfg.minAtrPct
  };
  const gatesOpen = conditions.rsi && conditions.macd && conditions.volume && conditions.trend && conditions.atr;

  // Bars-to-cross from the EMA spread's own slope
  let barsToCross = null;
  if (li >= 2 && eF[li - 1] !== null) {
    const spread = pf - ps, prevSpread = eF[li - 1] - eS[li - 1];
    const slope = spread - prevSpread;
    if (Math.abs(slope) > 1e-12 && Math.sign(spread) !== Math.sign(spread + slope * 20)) {
      const b = -spread / slope;
      if (b > 0 && b < 50) barsToCross = b;
    }
  }

  // MACD histogram convergence — the other half of "about to fire"
  const histNow = m.hist[li], histPrev = m.hist[li - 1];
  const macdConverging = histNow !== null && histPrev !== null &&
    (side === 'LONG' ? histNow > histPrev : histNow < histPrev);

  // Readiness 0-100: mostly distance, plus gate credit
  const distScore = Math.max(0, 100 - (Math.abs(distPct) / cfg.preAlertPct) * 50);
  const gateScore = [conditions.rsi, conditions.macd, conditions.volume, conditions.trend, conditions.atr]
    .filter(Boolean).length / 5 * 100;
  const readiness = Math.round(distScore * 0.65 + gateScore * 0.35);

  const imminent = pos === 0 && gatesOpen &&
    (Math.abs(distPct) <= cfg.preAlertPct || (barsToCross !== null && barsToCross <= cfg.preAlertBars));

  return {
    side, triggerPrice: trigger, distancePct: distPct,
    barsToCross, macdConverging, conditions, gatesOpen, readiness, imminent,
    msToBarClose: Math.max(0, candles[candles.length - 1].closeTime - Date.now())
  };
}
