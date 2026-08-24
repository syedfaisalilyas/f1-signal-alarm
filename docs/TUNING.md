# Why the defaults are what they are

Everything below is measured on the 20 most volatile USDⓈ-M perps, with costs
charged at 0.14% round trip (0.05% taker each side plus modest slippage). A
trade's cost in R is `0.14 / stop%` — tight stops are expensive, which turns out
to be the whole story.

## The 3m/5m strategy has no edge after costs

Roughly 4,300 trades over 17 days, every variation scored on a stretch of days
the search never saw:

| tested | variations | best out-of-sample result |
|---|---|---|
| Entry filters (volatility, session, side, stop width, volume) | 17 | all negative |
| Exit settings (breakeven, trail, targets, time stop, stop mode) | 17 | −0.025R |
| Higher-timeframe trend alignment | 11 | all negative |
| Daily rotation into the top 3 volatile coins | — | −45% in 14 days |
| Weekly walk-forward coin selection | — | negative |

Gross edge was about +0.008R per trade — indistinguishable from zero — and fees
cost ~0.056R. Both of the obvious fixes made it worse: moving to breakeven at
0.3R turned winners into scratches (win rate 65% → 55%), and widening the trail
changed nothing.

## Timeframe is what fixes it

Same signal, slower charts. Fee drag falls as stops widen:

| timeframe | avg trade after costs | avg stop | fee cost |
|---|---|---|---|
| 5m | −0.056R | 3.82% | 0.056R |
| 15m | −0.025R | 7.66% | 0.044R |
| 30m | **+0.027R** | 8.34% | 0.031R |
| 1h | +0.012R | 10.21% | 0.022R |
| 4h | +0.022R | 20.63% | 0.011R |

The improvement is monotonic in stop width, which is what the cost arithmetic
predicts — a mechanism rather than a coincidence.

## The tuned 30m defaults

Ranked by the **worse** of two independent 31-day halves, so a config that only
works in one half cannot win:

| config | half 1 | half 2 |
|---|---|---|
| previous defaults | −0.020R | +0.012R |
| fixed RR targets alone | +0.013R | +0.018R |
| **`minEmaSep: 0.3` + RR 0.5/1.5, no runner** | **+0.175R** (t=1.74) | **+0.109R** (t=1.61) |

So: `tpMode: 'rr'`, `rr1: 0.5`, `rr2: 1.5`, `runner: false`, `minEmaSep: 0.3`.

Demanding real EMA separation cuts the trade count about eightfold — roughly
**2 trades a day across 20 coins** — and lifts the average trade from −0.02R to
+0.11R. Fewer, better, and few enough to actually execute by hand.

## What this is not

**t ≈ 1.7, and ~2.0 is the usual bar for calling an edge real.** Worse, roughly
30 configurations were tried before this one won, and testing many things makes
the best of them look better than it is. Treat the effect as promising, not
proven.

At 1% risk on a $100 wallet, +0.11R × 2 trades/day is about **$0.22/day**, or
~7% a month if it holds. That is a good return by professional standards. It is
not a large daily number, and no setting in this repo produces one — leverage
multiplies the edge and the drawdowns equally, so it cannot manufacture an edge
that isn't there.

The honest next step is forward testing: let the scheduled scanner collect live
signals for a few weeks and compare them against this table.
