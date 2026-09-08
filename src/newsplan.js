// What a release means, and the trade it implies.
//
// The calendar tells you CPI lands at 17:30. It does not tell you which way to
// lean, and "High impact" is not a direction. This adds the missing half:
//
//   reaction   for each release, what a number ABOVE forecast does to this
//              instrument, and why. Not a guess — a chain of causation you can
//              check: hot CPI keeps the Fed tight, tight means higher real
//              yields, and gold pays no yield, so gold falls.
//   plan       a conditional trade written before the number lands. Both
//              branches, with real levels, because the whole point is that you
//              do not know which branch you will get.
//   backtest   the same rule applied to the releases that already happened,
//              scored against what price actually did. If the rule is no good,
//              this is where it shows.
//
// The honest limit, stated once: the free calendar publishes forecast and
// previous but never the actual. So the rule cannot be scored on "was the
// number a beat" — it is scored on whether price moved the way the rule's
// direction implied, which is the part a trade depends on anyway.

import { atr as atrSeries } from './indicators.js';

// higher: what the instrument does when the number comes in ABOVE forecast.
//
// The signs are not arbitrary and several are counter-intuitive, which is
// exactly why they are written down. More jobless claims is a WORSE economy,
// so it is dovish, so gold rises — the number went up and so did gold. Higher
// CPI is a better number for the dollar and a worse one for gold.
const GOLD_RULES = [
  { re: /core cpi|^cpi|consumer price/i, higher: 'down', weight: 3,
    what: 'The shopping-bill number — how much more everything costs. "m/m" is versus last month, "y/y" versus last year, and "Core" leaves out food and fuel because those jump around for reasons the central bank cannot control.',
    plain: 'Prices rising faster than expected means the central bank keeps interest rates high to cool things down. High rates make cash and bonds pay well, and gold pays nothing at all — so people sell gold to hold those instead.',
    why: 'hot inflation keeps the Fed tight — real yields rise, and gold pays no yield to compete' },
  { re: /core ppi|^ppi|producer price/i, higher: 'down', weight: 2,
    what: 'What factories and wholesalers charge shops — the price of things before they reach you. "Core" leaves out food and fuel.',
    plain: 'These costs get passed on to you a month or two later, so this is an early warning on inflation. Hotter than expected points to rates staying high, which hurts gold.',
    why: 'producer prices feed consumer inflation, so a hot print points at a tighter Fed' },
  { re: /non-?farm|nfp|employment change|payroll/i, higher: 'down', weight: 3,
    what: 'How many jobs America added last month. The biggest scheduled number there is.',
    plain: 'Lots of new jobs means a strong economy, which lets the central bank keep rates high without hurting anyone. High rates are bad for gold. Fewer jobs is the opposite — rate cuts get priced in and gold rallies.',
    why: 'a strong labour market lets the Fed stay tight — dollar and yields up, gold down' },
  { re: /unemployment claims|jobless/i, higher: 'up', weight: 2,
    what: 'How many people filed for jobless benefits last week.',
    plain: 'This one is backwards from what it sounds like. MORE people losing jobs means a weakening economy, which forces the central bank to cut rates, which is GOOD for gold. So a bigger number sends gold up.',
    why: 'more claims is a weaker labour market, which pulls the Fed dovish — gold bid' },
  { re: /unemployment rate/i, higher: 'up', weight: 2,
    what: 'The share of people who want a job and cannot find one.',
    plain: 'Also backwards. A higher jobless rate means a struggling economy, which means rate cuts are coming, which lifts gold.',
    why: 'a rising jobless rate is dovish pressure on the Fed, and gold gains when cuts get priced' },
  { re: /federal funds|rate decision|main refinancing|bank rate|official cash/i, higher: 'down', weight: 3,
    what: 'The central bank actually setting the interest rate.',
    plain: 'This is the thing everything else is guessing about. A higher rate pays you more to sit in cash, and gold pays nothing — so gold falls. A cut does the reverse.',
    why: 'a higher policy rate raises the return on holding cash instead of metal' },
  { re: /fomc|monetary policy statement|powell|press conference/i, higher: 'down', weight: 3,
    what: 'The head of the central bank explaining what they plan to do next.',
    plain: 'No number here — it is about tone. Sounding worried about inflation ("hawkish") means rates stay high and gold drops. Sounding worried about jobs ("dovish") means cuts, and gold jumps. These can move more than the data itself.',
    why: 'hawkish guidance lifts real yields, which is what gold competes against' },
  { re: /retail sales/i, higher: 'down', weight: 2,
    what: 'How much people actually spent in shops last month.',
    plain: 'Strong spending means the economy is fine and there is no reason to cut rates. That firms the dollar and pushes gold down.',
    why: 'strong consumption argues against cuts, firming the dollar' },
  { re: /\bgdp\b/i, higher: 'down', weight: 2,
    what: 'The size of the entire economy — is it growing or shrinking.',
    plain: 'Faster growth means no need for rate cuts, which is bad for gold. A shrinking economy means cuts are coming, which is good for gold.',
    why: 'faster growth reduces the case for easing' },
  { re: /inflation expectations/i, higher: 'up', weight: 1,
    what: 'What ordinary people think prices will do over the next year.',
    plain: 'When people expect prices to keep climbing, they buy gold as protection. That demand can lift gold even while rates are high — which is why this one points up, not down.',
    why: 'gold is bought as the hedge when expected inflation rises, even as yields firm' },
  { re: /consumer sentiment|confidence/i, higher: 'down', weight: 1,
    what: 'A survey asking people how good they feel about their money.',
    plain: 'Confident people spend, spending keeps the economy warm, and a warm economy means no rate cuts. Mildly bad for gold. This is a soft survey though, so it moves things far less than real data.',
    why: 'a confident consumer supports the growth-and-tight-policy read' },
  { re: /ism|pmi|manufacturing|services/i, higher: 'down', weight: 1,
    what: 'A survey of company managers. Above 50 means business is growing, below 50 means shrinking.',
    plain: 'Growth argues for keeping rates high for longer, which weighs on gold. A weak reading points at cuts and lifts it.',
    why: 'expansion readings argue for tighter policy for longer' }
];

// FX is simpler and more mechanical: strong data lifts its own currency. The
// direction then depends on which side of the pair that currency sits.
const FX_STRENGTHENS = [
  { re: /core cpi|^cpi|^ppi|core ppi|consumer price|producer price/i, higher: 'strong', weight: 3,
    why: 'hot inflation brings rate rises forward, which bids the currency' },
  { re: /non-?farm|employment change|payroll|retail sales|\bgdp\b|ism|pmi/i, higher: 'strong', weight: 2,
    why: 'strong activity data supports tighter policy and a firmer currency' },
  { re: /unemployment rate|unemployment claims|jobless/i, higher: 'weak', weight: 2,
    why: 'a softer labour market pushes the central bank dovish, which sells the currency' },
  { re: /rate decision|federal funds|main refinancing|bank rate|official cash/i, higher: 'strong', weight: 3,
    why: 'a higher policy rate pays more to hold the currency' }
];

// Returns { higher, why, weight } — or null when nothing in the table matches,
// which is a real answer: no stated view beats a fabricated one.
export function reactionFor(instrument, symbol, title, currency = 'USD') {
  if (instrument === 'gold' || instrument === 'silver') {
    const hit = GOLD_RULES.find(r => r.re.test(title));
    if (!hit) return null;
    // The table is written in dollar terms, because gold is priced in dollars.
    // A foreign release runs the other way: a hotter euro number lifts the euro,
    // which is the same thing as a softer dollar, which lifts gold. Reading an
    // ECB hike as gold-negative had it exactly backwards.
    const foreign = currency !== 'USD';
    const higher = foreign ? (hit.higher === 'up' ? 'down' : 'up') : hit.higher;
    return {
      higher, weight: foreign ? Math.max(1, hit.weight - 1) : hit.weight,
      what: hit.what,
      plain: foreign
        ? `${hit.plain} This one is not a US release, though, so for gold it works backwards: a strong ${currency} number means a weaker dollar, and gold is priced in dollars — so gold goes the other way, and by less.`
        : hit.plain,
      why: foreign
        ? `${hit.why.replace(/the Fed/g, `the ${currency} central bank`)} — and for gold that runs through a softer dollar, so the effect is inverted and weaker`
        : hit.why
    };
  }
  if (instrument === 'oil') return null;              // oil is supply-driven; no honest table here

  const legs = (symbol || '').toUpperCase().match(/[A-Z]{3}/g);
  if (!legs || legs.length < 2) return null;
  const hit = FX_STRENGTHENS.find(r => r.re.test(title));
  if (!hit) return null;
  const g = GOLD_RULES.find(r => r.re.test(title));
  return { higher: hit.higher, why: hit.why, weight: hit.weight, fx: true,
    what: g?.what || null,
    plain: g ? `${g.what} For a currency pair the logic is simpler than for gold: a strong number lifts that country's own currency, because it brings interest-rate rises closer.` : null,
    base: legs[0], quote: legs[1] };
}

// Turn that into a direction for THIS pair: strengthening the base currency
// lifts the pair; strengthening the quote sinks it.
export function directionFor(reaction, currency) {
  if (!reaction) return null;
  if (!reaction.fx) return reaction.higher;                 // gold: already up/down
  const strong = reaction.higher === 'strong';
  if (currency === reaction.base) return strong ? 'up' : 'down';
  if (currency === reaction.quote) return strong ? 'down' : 'up';
  return null;
}

// ─────────────── the conditional plan ───────────────

// Expected move: what this release has actually done here before, falling back
// to the instrument's own 30-minute volatility when there is no history yet.
function expectedMove(priorRanges, bars) {
  if (priorRanges.length) {
    return +(priorRanges.reduce((a, b) => a + b, 0) / priorRanges.length).toFixed(2);
  }
  const closed = bars.filter(b => b.closed).slice(-300);
  if (closed.length < 20) return null;
  // atr() takes parallel arrays, not bars.
  const a = atrSeries(closed.map(b => b.h), closed.map(b => b.l), closed.map(b => b.c), 14).at(-1);
  const px = closed.at(-1).c;
  // ATR is per 5m bar; six of them is the half hour the study measures.
  return px > 0 && a ? +((a * 2.4) / px * 100).toFixed(2) : null;
}

const round = (v, px) => px >= 100 ? +v.toFixed(2) : px >= 1 ? +v.toFixed(4) : +v.toPrecision(6);

// Both branches, written before the number lands. The stop sits beyond the
// pre-release range rather than a fixed percentage, because the thing that
// takes you out on a release is the whipsaw through the other side of the
// balance, not a clean move against you.
export function planFor({ event, reaction, price, bars, priorRanges = [], name = 'it' }) {
  const dir = directionFor(reaction, event.currency);
  const move = expectedMove(priorRanges, bars);
  if (!dir || !move || !(price > 0)) return null;

  const closed = bars.filter(b => b.closed);
  const pre = closed.slice(-12);                      // the hour into the release
  const hi = pre.length ? Math.max(...pre.map(b => b.h)) : price;
  const lo = pre.length ? Math.min(...pre.map(b => b.l)) : price;

  const branch = (side, label) => {
    const up = side === 'LONG';
    const entry = up ? Math.max(hi, price * 1.0005) : Math.min(lo, price * 0.9995);
    const stop = up ? Math.min(lo, entry * (1 - move / 200)) : Math.max(hi, entry * (1 + move / 200));
    const risk = Math.abs(entry - stop);
    const t1 = up ? entry + risk * 1.5 : entry - risk * 1.5;
    const t2 = up ? entry + price * move / 100 : entry - price * move / 100;
    return {
      side, condition: label,
      entry: round(entry, price), stop: round(stop, price),
      targets: [round(t1, price), round(t2, price)],
      riskPct: +(risk / entry * 100).toFixed(2),
      rr: risk > 0 ? +(Math.abs(t2 - entry) / risk).toFixed(1) : null
    };
  };

  // The rule's direction is what a number ABOVE forecast implies; below it is
  // the mirror. Both are written out because you cannot know which you will get.
  const upIsAbove = dir === 'up';
  const branches = [
    branch(upIsAbove ? 'LONG' : 'SHORT', `${event.title} comes in ABOVE ${event.forecast || 'forecast'}`),
    branch(upIsAbove ? 'SHORT' : 'LONG', `${event.title} comes in BELOW ${event.forecast || 'forecast'}`)
  ];

  // A release whose typical move is smaller than the range you must risk to
  // trade the break is not a setup, however loud the calendar calls it. Saying
  // so is the useful answer — a 0.6:1 plan dressed up as a trade is how a
  // scorecard fills with losses.
  const bestRR = Math.max(...branches.map(b => b.rr || 0));
  const rangePct = hi > 0 ? (hi - lo) / hi * 100 : 0;
  const worthIt = bestRR >= 1.2;

  return {
    expectedMovePct: move,
    basis: priorRanges.length ? `average of the last ${priorRanges.length} of these releases` : 'this instrument’s own 30-minute volatility',
    preRange: { hi: round(hi, price), lo: round(lo, price), widthPct: +rangePct.toFixed(2) },
    branches,
    bestRR: +bestRR.toFixed(1),
    verdict: worthIt ? 'take' : 'skip',
    verdictWhy: worthIt
      ? `Typical move of ${move}% clears the ${rangePct.toFixed(2)}% pre-release range, so a break has room to pay.`
      : `This release usually moves ${name} ${move}%, but the hour into it is already ${rangePct.toFixed(2)}% wide — the break would risk more than the move typically delivers (${bestRR.toFixed(1)}:1). Sit this one out unless price coils first.`,
    why: reaction.why
  };
}

// ─────────────── did the rule work ───────────────

// Every release in the window, with the plan that would have been written for
// it and what price then did. Scored on the branch that the move itself
// selected: the feed gives no actual, so "above or below forecast" is unknown,
// but which way price broke is not — and that is the branch a trader is in.
//
// A trade is counted a win when price reached target 1 before the stop, walking
// the 5m bars in order. A bar that touches both is scored as a loss: with only
// OHLC there is no way to know which came first, and the pessimistic read is
// the one that does not flatter the rule.
export function backtest({ events, bars, instrument, symbol, windowMin = 30 }) {
  const closed = bars.filter(b => b.closed);
  const out = [];

  for (const e of events) {
    const reaction = reactionFor(instrument, symbol, e.title, e.currency);
    if (!reaction) continue;
    const before = closed.filter(b => b.closeTime <= e.at);
    const after = closed.filter(b => b.t >= e.at && b.t < e.at + windowMin * 60000);
    if (before.length < 20 || after.length < 3) continue;

    const price = before.at(-1).c;
    const plan = planFor({ event: e, reaction, price, bars: before, priorRanges: [] });
    if (!plan) continue;

    // Which branch the market chose: the first of the two entries that traded.
    let taken = null;
    for (const bar of after) {
      for (const b of plan.branches) {
        const hit = b.side === 'LONG' ? bar.h >= b.entry : bar.l <= b.entry;
        if (hit) { taken = b; break; }
      }
      if (taken) break;
    }
    if (!taken) {
      out.push({ at: e.at, title: e.title, currency: e.currency, impact: e.impact,
        outcome: 'no trade', note: 'neither side broke its trigger', direction: null, rMultiple: null });
      continue;
    }

    const from = after.findIndex(b => (taken.side === 'LONG' ? b.h >= taken.entry : b.l <= taken.entry));
    const risk = Math.abs(taken.entry - taken.stop);
    let outcome = 'open', rMultiple = null;
    for (const bar of after.slice(from)) {
      const hitStop = taken.side === 'LONG' ? bar.l <= taken.stop : bar.h >= taken.stop;
      const hitT1 = taken.side === 'LONG' ? bar.h >= taken.targets[0] : bar.l <= taken.targets[0];
      if (hitStop) { outcome = 'stopped'; rMultiple = -1; break; }
      if (hitT1) { outcome = 'target'; rMultiple = 1.5; break; }
    }
    if (outcome === 'open') {
      const last = after.at(-1).c;
      rMultiple = risk > 0
        ? +(((taken.side === 'LONG' ? last - taken.entry : taken.entry - last) / risk).toFixed(2))
        : 0;
      outcome = rMultiple >= 0 ? 'open +' : 'open −';
    }

    out.push({
      at: e.at, title: e.title, currency: e.currency, impact: e.impact,
      side: taken.side, condition: taken.condition,
      entry: taken.entry, stop: taken.stop, target: taken.targets[0],
      outcome, rMultiple,
      direction: taken.side === 'LONG' ? 'up' : 'down',
      matchedRule: reaction.why
    });
  }

  const scored = out.filter(t => typeof t.rMultiple === 'number' && isFinite(t.rMultiple));
  const wins = scored.filter(t => t.rMultiple > 0).length;
  return {
    trades: out.sort((a, b) => b.at - a.at),
    summary: scored.length ? {
      count: scored.length,
      wins,
      losses: scored.length - wins,
      winRate: Math.round(wins / scored.length * 100),
      totalR: +scored.reduce((s, t) => s + t.rMultiple, 0).toFixed(2)
    } : null
  };
}
